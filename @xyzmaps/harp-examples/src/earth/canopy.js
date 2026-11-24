const { mercatorY } = require("./canopy-grid");
const { createPatch } = require("./canopy-material");
const { createTextureLoader } = require("./textures");

function createCanopy(THREE, map, sky, getHeight, getSurfacePages, lowMemory) {
    const capabilities = map.renderer.capabilities;
    const supported =
        capabilities.maxVertexTextures > 0 &&
        (capabilities.isWebGL2 || map.renderer.extensions.has("ANGLE_instanced_arrays"));
    const stats = { supported, enabled: false, patches: 0, instances: 0, pending: 0, failures: 0 };
    const limit = lowMemory ? 480 : 950;
    const loader = createTextureLoader(THREE);
    const ready = new Map(),
        pending = new Map(),
        misses = new Map();
    let wanted = new Map(),
        worker,
        atlas,
        cancelAtlas,
        retry,
        serial = 0,
        disposed = false;
    let mode = "a",
        workerRetry = 0,
        lastPlan = "";
    const geo = () => map.projection.unprojectPoint(map.camera.position);
    function counts() {
        stats.patches = ready.size;
        stats.instances = 0;
        for (const p of ready.values()) stats.instances += p?.mesh.geometry.instanceCount || 0;
        stats.pending = pending.size;
    }
    function stop() {
        worker?.terminate();
        worker = undefined;
        cancelAtlas?.();
        cancelAtlas = undefined;
        clearTimeout(retry);
        retry = undefined;
        for (const patch of ready.values()) patch?.dispose();
        ready.clear();
        pending.clear();
        misses.clear();
        wanted.clear();
        lastPlan = "";
        atlas?.dispose();
        atlas = undefined;
        counts();
    }
    function later(ms) {
        if (retry !== undefined) return;
        retry = setTimeout(() => {
            retry = undefined;
            if (!disposed) map.update();
        }, ms);
    }
    function failWorker() {
        worker?.terminate();
        worker = undefined;
        pending.clear();
        stats.failures++;
        workerRetry = performance.now() + 30000;
        counts();
        later(30000);
    }
    function pump() {
        if (!atlas || !worker) return;
        const now = performance.now();
        for (const [key, tile] of wanted) {
            if (pending.size >= 2) break;
            if (ready.has(key) || pending.has(key) || (misses.get(key) ?? 0) > now) continue;
            const id = ++serial;
            pending.set(key, id);
            worker.postMessage({ id, tile, limit });
        }
        counts();
    }
    function connect() {
        if (performance.now() < workerRetry) return;
        if (!worker) {
            try {
                worker = new Worker(require("./worker-url").earthWorkerUrl("earth-canopy"));
            } catch {
                failWorker();
                return;
            }
            worker.onerror = failWorker;
            worker.onmessage = ({ data }) => {
                const entry = [...pending].find(([, id]) => id === data.id);
                if (!entry) return;
                const key = entry[0];
                pending.delete(key);
                const tile = wanted.get(key);
                if (tile && data.error) {
                    stats.failures++;
                    misses.set(key, performance.now() + 30000);
                    later(30000);
                } else if (tile) {
                    const values = data.values;
                    const patch = values?.length
                        ? createPatch(
                              THREE,
                              map,
                              tile,
                              values,
                              atlas,
                              getHeight,
                              getSurfacePages,
                              sky.uniforms.sunDirection
                          )
                        : null;
                    ready.set(key, patch);
                }
                pump();
                map.update();
            };
        }
        if (!atlas && !cancelAtlas) {
            cancelAtlas = loader.load(
                "resources/earth/tree-crowns.webp",
                t => {
                    cancelAtlas = undefined;
                    atlas = t;
                    t.generateMipmaps = true;
                    t.minFilter = THREE.LinearMipmapLinearFilter;
                    pump();
                    map.update();
                },
                undefined,
                () => {
                    cancelAtlas = undefined;
                    stats.failures++;
                    workerRetry = performance.now() + 30000;
                    later(30000);
                }
            );
        }
        pump();
    }
    function update(nextMode) {
        mode = nextMode;
        if (!stats.enabled) return;
        const p = geo();
        const alt = map.camera.position.length() - 6378137;
        if (
            mode !== "a" ||
            document.hidden ||
            p.latitude > 84 ||
            p.latitude < -60 ||
            alt - getHeight(p) > 1700
        ) {
            if (worker || atlas || ready.size) stop();
            return;
        }
        const latitude = (p.latitude * Math.PI) / 180,
            cos = Math.cos(latitude);
        const z = Math.max(12, Math.min(16, Math.round(16 + Math.log2(cos)))),
            n = 2 ** z;
        // Centre the neighbourhood a little ahead of the camera when looking
        // along the ground. Large center-ray distances must not skip the foreground.
        const mx = (p.longitude + 180) / 360,
            my = mercatorY(p.latitude);
        const tx = map.target;
        const aheadX = tx ? (((tx.longitude - p.longitude + 540) % 360) - 180) * cos : 0;
        const aheadY = tx ? tx.latitude - p.latitude : 0;
        const advance = Math.min(1, 0.0023 / Math.max(0.00001, Math.hypot(aheadX, aheadY)));
        const x = Math.floor((mx + (advance * aheadX) / (360 * cos)) * n);
        const y = Math.floor((my - (advance * aheadY) / (360 * cos)) * n);
        const plan = z + "/" + x + "/" + y;
        if (plan !== lastPlan) {
            lastPlan = plan;
            const next = new Map();
            for (const [dx, dy] of [
                [0, 0],
                [0, 1],
                [0, -1],
                [-1, 0],
                [1, 0],
                [-1, -1],
                [1, -1],
                [-1, 1],
                [1, 1]
            ]) {
                const tile = { z, x: (((x + dx) % n) + n) % n, y: y + dy };
                if (tile.y < 0 || tile.y >= n) continue;
                next.set(tile.z + "/" + tile.x + "/" + tile.y, tile);
            }
            wanted = next;
            for (const [key, patch] of ready)
                if (!wanted.has(key)) {
                    patch?.dispose();
                    ready.delete(key);
                }
            for (const key of misses.keys()) if (!wanted.has(key)) misses.delete(key);
        }
        connect();
        // A terrain arrival can affect several patches. Re-anchor at most one
        // per frame to keep a burst of detailed DEM arrivals within the budget.
        for (const patch of ready.values())
            if (patch?.updateGround()) {
                map.update();
                break;
            }
    }
    return {
        stats,
        setEnabled(value) {
            const on = !!(supported && value);
            if (on === stats.enabled) return;
            stats.enabled = on;
            workerRetry = 0;
            if (!on) stop();
            map.update();
        },
        update,
        dispose() {
            disposed = true;
            stop();
            loader.dispose();
        }
    };
}
module.exports = { createCanopy };
