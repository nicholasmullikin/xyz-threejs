const { lidarEnterDistance, lidarExitDistance } = require("./survey-budget");
const { coordinates, tileFrame, heightInGrid } = require("./lidar-grid");
const { transform } = require("./math");
function createPatch(THREE, map, terrainState, getHeight, tile, data) {
    const { lat, lon, metres } = tileFrame(tile.x, tile.y, tile.z);
    const up = new THREE.Vector3(
        Math.cos(lat) * Math.cos(lon),
        Math.cos(lat) * Math.sin(lon),
        Math.sin(lat)
    );
    const east = new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0),
        north = up.clone().cross(east);
    const geometry = new THREE.BufferGeometry(),
        count = data.pos.length / 3,
        div = data.divisions,
        n = 2 ** tile.z;
    const uv = new THREE.BufferAttribute(new Float32Array(2 * count), 2),
        deltas = new Float32Array(count);
    const coarse = 8,
        base = new Float32Array((coarse + 1) ** 2);
    for (let y = 0; y <= coarse; y++)
        for (let x = 0; x <= coarse; x++) {
            const mx = (tile.x + x / coarse) / n,
                my = (tile.y + y / coarse) / n;
            base[y * (coarse + 1) + x] = getHeight.nativeAtMercator(mx, my);
        }
    // Store half the normal difference in normalized 16-bit components.
    // The terrain shader applies it with the same weight as the height morph.
    const normalDelta = new Int16Array(count * 3);
    const baseNormal = new THREE.Vector3(), surveyNormal = new THREE.Vector3();
    let minDelta = 0,
        maxDelta = 0;
    for (let k = 0; k < count; k++) {
        const x = Math.round((data.pos[k * 3] / metres + 0.5) * div),
            y = Math.round((0.5 - data.pos[k * 3 + 1] / metres) * div);
        const gx = (x / div) * coarse,
            gy = (y / div) * coarse,
            ix = Math.min(coarse - 1, Math.floor(gx)),
            iy = Math.min(coarse - 1, Math.floor(gy)),
            u = gx - ix,
            v = gy - iy;
        const i = iy * (coarse + 1) + ix,
            h =
                (1 - v) * ((1 - u) * base[i] + u * base[i + 1]) +
                v * ((1 - u) * base[i + coarse + 1] + u * base[i + coarse + 2]);
        const edge = Math.min(1, Math.min(x, y, div - x, div - y) / 2);
        const stride = coarse + 1;
        const eastRise = (1 - v) * (base[i + 1] - base[i]) +
            v * (base[i + stride + 1] - base[i + stride]);
        const southRise = (1 - u) * (base[i + stride] - base[i]) +
            u * (base[i + stride + 1] - base[i + 1]);
        baseNormal.set(-eastRise, southRise, metres / coarse).normalize();
        surveyNormal.fromArray(data.normal, 3 * k).normalize().lerp(baseNormal, 1 - edge).normalize();
        for (let axis = 0; axis < 3; axis++) {
            const end = surveyNormal.getComponent(axis);
            data.normal[3 * k + axis] = Math.round(end * 32767);
            normalDelta[3 * k + axis] = Math.round((baseNormal.getComponent(axis) - end) * 16383.5);
        }
        // Match the native terrain along the patch perimeter and morph off
        // that same surface as measurements arrive.
        data.pos[k * 3 + 2] = h + (data.pos[k * 3 + 2] - h) * edge;
        deltas[k] = h - data.pos[k * 3 + 2];
        minDelta = Math.min(minDelta, deltas[k]);
        maxDelta = Math.max(maxDelta, deltas[k]);
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(data.pos, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(data.normal, 3, true));
    geometry.setAttribute("terrainSourceNormal", new THREE.BufferAttribute(normalDelta, 3, true));
    geometry.setAttribute("uv", uv);
    geometry.setAttribute("terrainSourceOffset", new THREE.BufferAttribute(deltas, 1));
    geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
    geometry.computeBoundingSphere();
    const morph = { value: 1 };
    const material = new THREE.ShaderMaterial({
        stencilWrite: true,
        stencilRef: 32,
        stencilWriteMask: 32,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.lidarSurface = true;
    mesh.anchor = up.clone().multiplyScalar(6378137);
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, north, up));
    mesh.renderOrder = -12;
    mesh.visible = false;
    const record = {
        tile: { disposed: false },
        mesh,
        position: geometry.attributes.position,
        matrix: new THREE.Matrix4().makeBasis(east, north, up).setPosition(mesh.anchor)
    };
    const transition = { delta: deltas, min: minDelta, max: maxDelta, factor: 1 };
    geometry.userData.terrainTransition = transition;
    let start, previous, version, level;
    function bind() {
        const state = terrainState(tile);
        mesh.visible = !!state;
        if (!state) {
            previous = start = undefined;
            material.uniforms = {};
            return;
        }
        const src = state.material;
        if (src !== previous || version !== src.version) {
            material.vertexShader = src.vertexShader;
            material.fragmentShader = src.fragmentShader;
            material.uniforms = {
                ...src.uniforms,
                terrainSourceScale: morph,
                terrainNormalMix: { value: 0 }
            };

            material.defines = { ...src.defines };
            material.extensions = { ...src.extensions };
            material.needsUpdate = true;
            previous = src;
            version = src.version;
        }
        if (level !== state.tile.z) {
            const [sx, sy, ox, oy] = transform(tile, state.tile);
            for (let i = 0; i < count; i++)
                uv.setXY(
                    i,
                    (data.pos[i * 3] / metres + 0.5) * sx + ox,
                    (data.pos[i * 3 + 1] / metres + 0.5) * sy + oy
                );
            uv.needsUpdate = true;
            level = state.tile.z;
        }
        const now = performance.now();
        start ??= now;
        const t = Math.min(1, (now - start) / 420);
        const range = Math.max(0, Math.min(1,
            (lidarExitDistance - map.targetDistance) / (lidarExitDistance - lidarEnterDistance)));
        morph.value = transition.factor = 1 - t * t * (3 - 2 * t) * range * range * (3 - 2 * range);
        material.uniforms.terrainNormalMix.value = 2 * morph.value;
        if (t < 1) map.update();
    }
    map.mapAnchors.add(mesh);
    return {
        bind,
        record,
        get blend() {
            return morph.value;
        },
        height(u, v) {
            if (!mesh.visible) return;
            const survey = heightInGrid(data.ground, div, u, v);
            if (survey === undefined) return;
            const h = heightInGrid(base, coarse, u, v);
            const edge = Math.min(1, (Math.min(u, v, 1 - u, 1 - v) * div) / 2);
            return h + (survey - h) * edge * (1 - morph.value);
        },
        divisions: div,
        triangles: data.index.length / 3,
        originalTriangles: data.trianglesBefore,
        bytes:
            data.pos.byteLength +
            data.normal.byteLength +
            data.index.byteLength +
            uv.array.byteLength +
            normalDelta.byteLength +
            deltas.byteLength +
            data.ground.byteLength,
        dispose() {
            record.tile.disposed = true;
            map.mapAnchors.remove(mesh);
            mesh.removeFromParent();
            material.uniforms = {};
            geometry.dispose();
            material.dispose();
        }
    };
}
function createLidarSurface(
    THREE,
    map,
    source,
    small,
    stats,
    terrainState,
    getHeight,
    networkBudget
) {
    let revision = 0,
        pickRevision = 0,
        worker,
        serial = 0,
        active,
        settle,
        previous = "",
        disposed = false;
    const ready = new Map(),
        misses = new Map(),
        owner = {};
    let desired = [];
    const idOf = t => t.x + "/" + t.y;
    const picker = require("./terrain-picking").createTerrainPicker(THREE);
    function updateStats() {
        stats.visible = ready.size;
        stats.bytes = 0;
        stats.triangles = stats.originalTriangles = 0;
        for (const p of ready.values()) {
            stats.bytes += p.bytes;
            stats.triangles += p.triangles;
            stats.originalTriangles += p.originalTriangles;
        }
        stats.pending = active ? 1 : 0;
    }
    function needsMeasurements(t) {
            // Compare samples across the same ground footprint. A ready regional
            // mesh can already resolve the local worker grid without downloading points.
            const state = terrainState(t);
            return !state || state.elevationLevel < 16 ||
                state.elevationSegments * 2 ** (state.tile.z - t.z) < (small ? 64 : 96);
    }
    function start() {
        if (disposed || active) return;
        const tile = desired.find(t => !ready.has(idOf(t)) &&
            (misses.get(idOf(t)) ?? 0) <= performance.now() && needsMeasurements(t));
        if (!tile) return;
        if (!worker) {
            worker = new Worker(require("./worker-url").earthWorkerUrl("earth-lidar"));
            worker.onerror = () => {
                if (active) misses.set(idOf(active.tile), performance.now() + 30000);
                worker?.terminate();
                worker = undefined;
                active = undefined;
                updateStats();
                map.update();
            };
            worker.onmessage = ({ data }) => {
                if (data.spent) {
                    networkBudget.pay(data.spent);
                    return;
                }
                if (disposed || data.id !== active?.id) return;
                const key = idOf(data.tile);
                if (data.mesh && (ready.has(key) || needsMeasurements(data.tile))) {
                    const patch = createPatch(
                        THREE,
                        map,
                        terrainState,
                        getHeight,
                        data.tile,
                        data.mesh
                    );
                    patch.samples = data.samples;
                    if (patch.samples) patch.bytes += patch.samples.byteLength;
                    revision++;
                    pickRevision++;
                    ready.get(key)?.dispose();
                    ready.set(key, patch);
                    stats.points = data.points;
                    stats.dataset = data.name;
                }
                if (!data.partial) {
                    stats.transferred = (stats.transferred || 0) + (data.bytes || 0);
                    if (data.error || data.empty) {
                        misses.set(key, performance.now() + (data.error ? 30000 : 300000));
                        if (data.error) stats.lastError = data.error;
                    }
                    active = undefined;
                    start();
                }
                updateStats();
                map.update();
            };
        }
        const { lat, lon } = tileFrame(tile.x, tile.y, tile.z);
        const elevation = getHeight({
            latitude: (lat * 180) / Math.PI,
            longitude: (lon * 180) / Math.PI
        });
        active = { id: ++serial, tile };
        worker.postMessage({
            ...active,
            credit: networkBudget.available(),
            elevation: Number.isFinite(elevation) ? elevation : map.target.altitude || 0,
            small
        });
        updateStats();
    }
    return {
        get groundRevision() {
            return pickRevision;
        },
        regionRevision(x, y, level) {
            const n = 2 ** (17 - level);
            for (const tile of desired)
                if (
                    tile.x >= x * n &&
                    tile.x < (x + 1) * n &&
                    tile.y >= y * n &&
                    tile.y < (y + 1) * n &&
                    ready.has(idOf(tile))
                )
                    return revision;
        },
        lidarWeightAt(mx, my) {
            const x = mx * 2 ** 17, y = my * 2 ** 17;
            const ix = Math.floor(x), iy = Math.floor(y);
            const patch = ready.get(ix + "/" + iy);
            if (patch?.height(x - ix, y - iy) !== undefined)
                return (1 - patch.blend) * Math.min(1, Math.min(x - ix, y - iy, ix + 1 - x, iy + 1 - y) * patch.divisions / 2);
        },
        groundAt(mx, my) {
            const n = 2 ** 17,
                x = mx * n,
                y = my * n,
                ix = Math.floor(x),
                iy = Math.floor(y);
            return ready.get(ix + "/" + iy)?.height(x - ix, y - iy);
        },
        pick(ray) {
            return picker(
                ray,
                Array.from(ready.values())
                    .filter(p => p.record.mesh.visible)
                    .map(p => p.record)
            );
        },
        roofSamples(tileKey) {
            const n = 2 ** (17 - tileKey.level),
                left = tileKey.column * n,
                top = tileKey.row * n;
            if (
                !desired.some(
                    tile =>
                        tile.x >= left &&
                        tile.x < left + n &&
                        tile.y >= top &&
                        tile.y < top + n &&
                        ready.get(idOf(tile))?.samples
                )
            )
                return;
            return {
                revision,
                owner,
                sample(u, v) {
                    const x = left + u * n,
                        y = top + v * n,
                        ix = Math.floor(x),
                        iy = Math.floor(y);
                    const data = ready.get(ix + "/" + iy)?.samples;
                    if (!data) return;
                    const side = Math.sqrt(data.length),
                        cx = Math.round((x - ix) * (side - 1)),
                        cy = Math.round((y - iy) * (side - 1));
                    const value = data[cy * side + cx];
                    if (Number.isFinite(value))
                        return { id: (ix * 131072 + iy) * 16384 + cy * side + cx, value };
                }
            };
        },
        update() {
            for (const patch of ready.values()) {
                const blend = patch.blend,
                    visible = patch.record.mesh.visible;
                patch.bind();
                if (blend !== patch.blend || visible !== patch.record.mesh.visible)
                    pickRevision++;
                // Re-seat geometry once the measured ground is in place.
                if ((blend !== patch.blend && patch.blend === 0) || visible !== patch.record.mesh.visible)
                    revision++;
            }
            const z = 17,
                n = 2 ** z,
                [u, v] = coordinates(map.target.latitude, map.target.longitude);
            const x = Math.floor(u * n),
                y = Math.floor(v * n);
            const camera = map.projection.unprojectPoint(map.camera.position);
            const [cu, cv] = coordinates(camera.latitude, camera.longitude);
            // Weight the visible foreground along the camera-to-target line.
            const ax = Math.max(-0.8, Math.min(0.8, (cu - u) * n)),
                ay = Math.max(-0.8, Math.min(0.8, (cv - v) * n));
            const centerState = terrainState({ x, y, z });
            const key = [x, y, Math.round(ax * 2), Math.round(ay * 2),
                centerState?.tile.z, centerState?.elevationLevel].join("/");
            if (key === previous) return;
            previous = key;
            desired = [];
            for (let j = -1; j <= 1; j++)
                for (let i = -1; i <= 1; i++) {
                    const dx = x + i + 0.5 - u * n,
                        dy = y + j + 0.5 - v * n;
                    desired.push({
                        x: x + i,
                        y: y + j,
                        z,
                        rank: Math.min(Math.hypot(dx, dy), 0.18 + Math.hypot(dx - ax, dy - ay))
                    });
                }
            desired.sort((a, b) => a.rank - b.rank);
            desired.length = small ? 4 : 6;
            const keep = new Set(desired.map(idOf));
            for (const [id, p] of ready)
                if (!keep.has(id)) {
                    p.dispose();
                    ready.delete(id);
                    revision++;
                    pickRevision++;
                }
            if (active && !keep.has(idOf(active.tile))) {
                worker?.postMessage({ cancel: true });
                active = undefined;
            }
            for (const [id, until] of misses)
                if (!keep.has(id) || until < performance.now()) misses.delete(id);
            clearTimeout(settle);
            // Let ready-to-draw survey rasters establish their resolution first.
            settle = setTimeout(start, ready.size ? 330 : 1200);
            updateStats();
        },
        dispose() {
            disposed = true;
            clearTimeout(settle);
            worker?.terminate();
            worker = undefined;
            active = undefined;
            for (const p of ready.values()) p.dispose();
            ready.clear();
        }
    };
}
module.exports = { createLidarSurface };
