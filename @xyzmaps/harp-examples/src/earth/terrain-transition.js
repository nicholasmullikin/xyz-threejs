// The opaque child borrows the shape of the terrain that occupied its footprint.
// The native positions and reconciled shared perimeter stay available for exact
// final rendering. A signed vertex offset supplies the temporary interior shape.
const { samplePosition, terrainTopology } = require("./terrain-sample");
const { gridWidth } = require("./terrain-grid");

const tileId = (level, column, row) => 4 ** level + row * 2 ** level + column;
const retreatTargets = new WeakMap();
const probes = [0.15, 0.5, 0.85];
function createTerrainTransitions(THREE, map, vertexBudget) {
    const active = new Map(),
        point = { x: 0, y: 0, z: 0 },
        sourceNormal = new Float64Array(3);
    let previous = new Map(),
        activeVertices = 0;
    function surface(tile) {
        const source = (tile.transitionSurface ??= {
            positions: tile.position.array,
            normals: tile.geometry.attributes.normal?.array,
            normalScale: tile.geometry.attributes.normal?.array instanceof Int16Array ? 1 / 32767 : 1,
            topology: terrainTopology(tile.geometry),
            diagonal: tile.geometry.userData.attributeMetadata?.position?.terrainDiagonal,
            width: gridWidth(tile.geometry)
        });
        source.morph = tile.geometry.userData.terrainTransition;
        return source;
    }
    function ancestorHeight(tile, ancestor) {
        const from = ancestor.matrix.elements,
            to = tile.matrix.elements;
        const x = to[8],
            y = to[9],
            z = to[10];
        const a = x * from[0] + y * from[1] + z * from[2];
        const b = x * from[4] + y * from[5] + z * from[6];
        const c = x * from[8] + y * from[9] + z * from[10];
        const offset = (from[12] - to[12]) * x + (from[13] - to[13]) * y + (from[14] - to[14]) * z;
        const scale = 2 ** (ancestor.z - tile.z);
        const left = tile.x * scale - ancestor.x,
            top = tile.y * scale - ancestor.y;
        const src = surface(ancestor);
        const rotation = new THREE.Matrix3()
            .setFromMatrix4(ancestor.matrix)
            .premultiply(tile.inverseRotation).elements;
        return (u, v, normal) => {
            samplePosition(src, left + u * scale, top + v * scale, point, normal);
            if (normal) {
                const nx = normal[0], ny = normal[1], nz = normal[2];
                normal[0] = rotation[0] * nx + rotation[3] * ny + rotation[6] * nz;
                normal[1] = rotation[1] * nx + rotation[4] * ny + rotation[7] * nz;
                normal[2] = rotation[2] * nx + rotation[5] * ny + rotation[8] * nz;
            }
            return a * point.x + b * point.y + c * point.z + offset;
        };
    }
    const retreatSources = new WeakMap();
    function retreatSurface(parent) {
        const mesh = parent.objects[0];
        if (!mesh?.geometry?.attributes.position) return;
        let record = retreatSources.get(mesh.geometry);
        if (!record) {
            const key = parent.tileKey;
            record = {
                z: key.level, x: key.column, y: key.row,
                geometry: mesh.geometry, position: mesh.geometry.attributes.position,
                matrix: parent.boundingBox.getRotationMatrix().setPosition(parent.center)
            };
            retreatSources.set(mesh.geometry, record);
        }
        return record;
    }
    function candidate(tile, retreat) {
        if (
            tile.tile.dataSource?.openingTiles ||
            tile.z < 9 ||
            tile.surfaceCount > vertexBudget ||
            !tile.mesh.material.uniforms?.terrainSourceScale
        )
            return;
        let { z, x, y } = tile,
            ancestor;
        if (retreat) ancestor = retreatSurface(retreat);
        while (!retreat && z >= 0) {
            ancestor = previous.get(tileId(z, x, y));
            if (ancestor) break;
            z--;
            x = Math.floor(x / 2);
            y = Math.floor(y / 2);
        }
        if (!ancestor || ancestor === tile) return;
        const height = ancestorHeight(tile, ancestor),
            src = surface(tile);
        const near = Math.max(20, tile.tile.boundingBox.distanceToPoint(map.camera.position));
        // Match the native drawing buffer used by the terrain selector, including
        // display scaling. The temporary navigation render target can change mid-blend.
        const heightPx = map.canvas.height || map.canvas.clientHeight;
        const focal = (heightPx * map.camera.projectionMatrix.elements[5]) / 2;
        let max = 0;
        for (const v of probes)
            for (const u of probes) {
                const prior = height(u, v);
                max = Math.max(max, Math.abs(prior - samplePosition(src, u, v, point).z));
            }
        // Probe the actual high and low interior vertices as well. A narrow ridge
        // can pass between all nine regular samples yet move the skyline.
        if (!tile.reliefExtrema) {
            const uv = tile.geometry.attributes.uv;
            let low = Infinity, high = -Infinity, bottom = -1, top = -1;
            for (let i = 0; i < tile.surfaceCount; i++) {
                const z = tile.position.getZ(i);
                if (z >= low && z <= high) continue;
                const u = uv.getX(i), v = uv.getY(i);
                if (u <= 0 || u >= 1 || v <= 0 || v >= 1) continue;
                if (z < low) { low = z; bottom = i; }
                if (z > high) { high = z; top = i; }
            }
            tile.reliefExtrema = bottom < 0 ? [] : [bottom, top];
        }
        for (const i of tile.reliefExtrema) {
            const uv = tile.geometry.attributes.uv;
            max = Math.max(max, Math.abs(height(uv.getX(i), 1 - uv.getY(i)) - tile.position.getZ(i)));
        }
        const pixels = (max * focal) / near;
        if (!(pixels >= 0.7)) return;
        const extent =
            (tile.tile.boundingBox.extents.length() * focal) / (near * heightPx);
        return {
            tile, height, pixels, retreat,
            hasNormals: !!surface(ancestor).normals,
            priority: pixels * Math.max(0.05, Math.min(2, extent))
        };
    }
    function start({ tile, height, pixels, retreat, hasNormals }, now) {
        const g = tile.geometry,
            uv = g.attributes.uv;
        const values = tile.position.array,
            cells = gridWidth(g) - 1;
        const offsets = new Float32Array(tile.surfaceCount);
        const native = surface(tile);
        const shade = hasNormals && native.normals && tile.mesh.material.uniforms.terrainNormalMix;
        let normalAttribute = g.attributes.terrainSourceNormal;
        if (shade && (!normalAttribute || normalAttribute.count !== tile.position.count)) {
            normalAttribute = new THREE.BufferAttribute(new Int8Array(3 * tile.position.count), 3, true);
            g.setAttribute("terrainSourceNormal", normalAttribute);
            tile.tile.invalidateResourceInfo();
        }
        const normalDelta = shade ? normalAttribute.array : undefined;
        // Boundary and skirt entries remain zero, matching the reconciled native seams.
        let amplitude = 0;
        for (let i = 0; i < offsets.length; i++) {
            const u = Math.round(cells * uv.getX(i)) / cells,
                v = Math.round(cells * (1 - uv.getY(i))) / cells;
            // The seam graph already reconciled the exact shared edge, including
            // mixed levels and neighbors that refine at different times.
            const edge = Math.min(1, 64 * Math.min(u, v, 1 - u, 1 - v));
            if (edge <= 0) continue;
            offsets[i] = edge * (height(u, v, shade ? sourceNormal : undefined) - values[3 * i + 2]);
            if (normalDelta) {
                // Signed unit normals differ by at most two on each axis.
                for (let axis = 0; axis < 3; axis++) {
                    const index = 3 * i + axis;
                    const difference = sourceNormal[axis] - native.normals[index] * native.normalScale;
                    normalDelta[index] = Math.max(-127, Math.min(127, Math.round(difference * edge * 63.5)));
                }
            }
            amplitude = Math.max(amplitude, Math.abs(offsets[i]));
        }
        if (!(amplitude > 0)) return;
        let attribute = g.attributes.terrainSourceOffset;
        if (!attribute || attribute.count !== tile.position.count) {
            attribute = new THREE.BufferAttribute(new Int16Array(tile.position.count), 1, true);
            g.setAttribute("terrainSourceOffset", attribute);
            tile.tile.invalidateResourceInfo();
        }
        const scale = amplitude / 32767;
        const delta = attribute.array;
        let min = 0,
            max = 0;
        for (let i = 0; i < offsets.length; i++) {
            const n = Math.round(offsets[i] / scale);
            delta[i] = n;
            min = Math.min(min, n);
            max = Math.max(max, n);
        }
        attribute.needsUpdate = true;
        if (normalDelta) normalAttribute.needsUpdate = true;
        g.userData.terrainTransition = { delta, min, max, factor: scale, normalDelta, normalFactor: 0 };
        active.set(tile, { scale, phase: retreat ? 0 : 1, time: now,
            duration: retreat ? 300 : Math.min(450, 170 + pixels * 2),
            // Limit progress per rendered frame. A late frame at 4K can otherwise
            // move a near ridge through most of the blend in one presentation.
            maxStep: 1 / Math.min(45, Math.max(6, Math.ceil((map.canvas.height || map.canvas.clientHeight) / 100), Math.ceil(pixels / 2))) });
        activeVertices += tile.surfaceCount;
    }
    return function transition(tiles, same, now = performance.now()) {
        // The draw cover may stay identical when a downgrade begins or reverses.
        const changedDirection = tiles.some(t => t.retreat !== retreatTargets.get(t.mesh));
        if (same && !active.size && !changedDirection) return;
        if (!same || changedDirection) {
            const next = new Map(),
                candidates = [];
            for (const t of tiles) {
                const id = tileId(t.z, t.x, t.y);
                next.set(id, t);
                const retreat = retreatTargets.get(t.mesh);
                const changed = t.retreat !== retreat;
                t.retreat = retreat;
                if (active.has(t) || (previous.get(id) === t && !(changed && retreat))) continue;
                const pick = candidate(t, retreat?.parent);
                if (pick) candidates.push(pick);
            }
            candidates.sort((a, b) => b.priority - a.priority);
            for (const c of candidates)
                if (activeVertices + c.tile.surfaceCount <= vertexBudget) start(c, now);
                else if (c.tile.tile.dataSource.diagnostic)
                    c.tile.mesh.userData.debugBudgetFrame = map.frameNumber;
            previous = next;
        }
        for (const [t, task] of active) {
            const visible = previous.get(tileId(t.z, t.x, t.y)) === t;
            const retreat = visible && retreatTargets.get(t.mesh);
            const since = retreat ? Math.max(task.time, retreat.start) : task.time;
            const step = Math.min(task.maxStep, Math.max(0, now - since) / (retreat ? 300 : task.duration));
            task.time = now;
            task.phase = visible ? Math.max(0, Math.min(1, task.phase + (retreat ? step : -step))) : 0;
            const remaining = task.phase * task.phase * (3 - 2 * task.phase);
            const factor = remaining * task.scale;
            const morph = t.geometry.userData.terrainTransition;
            morph.retiring = !!retreat;
            morph.atParent = !!retreat && task.phase === 1;
            if (morph.normalDelta) {
                t.mesh.material.uniforms.terrainNormalMix.value = 2 * remaining;
                morph.normalFactor = 2 * remaining / 127;
            }
            t.mesh.material.uniforms.terrainSourceScale.value = 32767 * factor;
            t.geometry.userData.terrainTransition.factor = factor;
            if (task.phase === 0 && !retreat) {
                t.retreat = undefined;
                delete t.geometry.userData.terrainTransition;
                if (t.transitionSurface) t.transitionSurface.morph = undefined;
                active.delete(t);
                activeVertices -= t.surfaceCount;
            }
        }
        if (active.size) map.update();
    };
}
module.exports = { createTerrainTransitions, retreatTargets };
