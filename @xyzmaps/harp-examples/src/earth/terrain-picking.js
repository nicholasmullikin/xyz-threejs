// Terrain meshes are opaque, have fixed UVs and move only with their tangent
// frame. Return the first actual surface intersection without collecting UVs
// or normals for every farther hit in every tile.
function createTerrainPicker(THREE) {
    const spatial = new WeakMap();
    const local = new THREE.Ray(),
        near = new THREE.Vector3(),
        hit = new THREE.Vector3();
    const a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        c = new THREE.Vector3();
    const box = new THREE.Box3();
    function indexFaces(geometry, end) {
        const index = geometry.index.array,
            uv = geometry.attributes.uv,
            faces = end / 3;
        const side = Math.min(16, Math.max(2, Math.ceil(Math.sqrt(faces / 64))));
        const bins = side * side,
            counts = new Uint32Array(bins),
            assignments = new Uint8Array(faces);
        for (let face = 0; face < faces; face++) {
            const i = 3 * face,
                j = index[i],
                k = index[i + 1],
                l = index[i + 2];
            const x = Math.min(
                side - 1,
                Math.max(0, Math.floor(((uv.getX(j) + uv.getX(k) + uv.getX(l)) * side) / 3))
            );
            const y = Math.min(
                side - 1,
                Math.max(0, Math.floor(((uv.getY(j) + uv.getY(k) + uv.getY(l)) * side) / 3))
            );
            assignments[face] = y * side + x;
            counts[assignments[face]]++;
        }
        const starts = new Uint32Array(bins + 1),
            offsets = new Uint32Array(bins);
        for (let i = 0; i < bins; i++) {
            starts[i + 1] = starts[i] + counts[i];
            offsets[i] = starts[i];
        }
        const order = faces <= 65536 ? new Uint16Array(faces) : new Uint32Array(faces);
        for (let face = 0; face < faces; face++) order[offsets[assignments[face]]++] = face;
        return { index, order, starts, bounds: new Float32Array(6 * bins), version: -1 };
    }
    function refreshBounds(tree, position) {
        const { index, starts, order, bounds } = tree,
            p = position.array;
        for (let bin = 0; bin < starts.length - 1; bin++) {
            let x0 = Infinity,
                y0 = Infinity,
                z0 = Infinity,
                x1 = -Infinity,
                y1 = -Infinity,
                z1 = -Infinity;
            for (let i = starts[bin]; i < starts[bin + 1]; i++) {
                const face = 3 * order[i];
                for (let j = 0; j < 3; j++) {
                    const vertex = 3 * index[face + j],
                        x = p[vertex],
                        y = p[vertex + 1],
                        z = p[vertex + 2];
                    x0 = Math.min(x, x0);
                    x1 = Math.max(x, x1);
                    y0 = Math.min(y, y0);
                    y1 = Math.max(y, y1);
                    z0 = Math.min(z, z0);
                    z1 = Math.max(z, z1);
                }
            }
            bounds.set([x0, y0, z0, x1, y1, z1], 6 * bin);
        }
        tree.version = position.version;
    }
    function distanceToBox(bounds) {
        if (bounds.containsPoint(local.origin)) return 0;
        return local.intersectBox(bounds, near) ? near.distanceToSquared(local.origin) : Infinity;
    }
    return function pick(ray, records) {
        const candidates = [];
        for (const record of records) {
            if (record.tile.disposed) continue;
            const geometry = record.mesh.geometry;
            if (!geometry.boundingBox) geometry.computeBoundingBox();
            record.inverse ??= record.matrix.clone().invert();
            local.copy(ray).applyMatrix4(record.inverse);
            const morph = geometry.userData?.terrainTransition;
            box.copy(geometry.boundingBox);
            if (morph) {
                box.min.z += morph.min * morph.factor;
                box.max.z += morph.max * morph.factor;
            }
            const distance = distanceToBox(box);
            if (Number.isFinite(distance)) candidates.push({ record, distance });
        }
        candidates.sort((first, second) => first.distance - second.distance);
        let nearest = Infinity,
            point;
        for (const { record, distance } of candidates) {
            if (distance > nearest) break;
            local.copy(ray).applyMatrix4(record.inverse);
            const { mesh, position } = record,
                geometry = mesh.geometry,
                index = geometry.index.array;
            const meta = geometry.userData?.attributeMetadata?.position;
            const edge = meta?.terrainEdgeWidth ?? meta?.terrainGridWidth;
            const end = edge ? index.length - (edge - 1) * 48 : index.length;
            const morph = geometry.userData?.terrainTransition;
            const back = mesh.material.side === THREE.BackSide,
                single = mesh.material.side !== THREE.DoubleSide;
            function testFace(face) {
                const i = 3 * face;
                a.fromBufferAttribute(position, index[i]);
                b.fromBufferAttribute(position, index[i + 1]);
                c.fromBufferAttribute(position, index[i + 2]);
                if (morph) {
                    a.z += morph.factor * morph.delta[index[i]];
                    b.z += morph.factor * morph.delta[index[i + 1]];
                    c.z += morph.factor * morph.delta[index[i + 2]];
                }
                if (!local.intersectTriangle(back ? c : a, b, back ? a : c, single, hit)) return;
                const d = hit.distanceToSquared(local.origin);
                if (d >= nearest) return;
                nearest = d;
                (point ??= new THREE.Vector3()).copy(hit).applyMatrix4(record.matrix);
            }
            if (end <= 4096 || !geometry.attributes.uv) {
                for (let i = 0; i < end / 3; i++) testFace(i);
            } else {
                let tree = spatial.get(geometry);
                if (!tree || tree.index !== index) {
                    tree = indexFaces(geometry, end);
                    spatial.set(geometry, tree);
                }
                if (tree.version !== position.version) refreshBounds(tree, position);
                const { starts, order, bounds } = tree;
                for (let bin = 0; bin < starts.length - 1; bin++) {
                    if (starts[bin] === starts[bin + 1]) continue;
                    box.min.fromArray(bounds, 6 * bin);
                    box.max.fromArray(bounds, 6 * bin + 3);
                    if (morph) {
                        box.min.z += morph.min * morph.factor;
                        box.max.z += morph.max * morph.factor;
                    }
                    const entry = distanceToBox(box);
                    if (!Number.isFinite(entry) || entry > nearest) continue;
                    for (let i = starts[bin]; i < starts[bin + 1]; i++) testFace(order[i]);
                }
            }
        }
        return point;
    };
}
module.exports = { createTerrainPicker };
