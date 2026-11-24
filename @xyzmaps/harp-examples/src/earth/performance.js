/* Bounded, asynchronous timing. No synchronous GPU readback or polling loop. */
function createProfiler(map) {
    const renderer = map.renderer,
        gl = renderer.getContext();
    const cpu = {},
        gpu = {},
        completed = new Map();
    let pending = [],
        api,
        disposed = false,
        frame = 0,
        gpuSample = 0,
        started = 0,
        depth = 0;
    function initialize() {
        const ext = gl.getExtension(
            renderer.capabilities.isWebGL2
                ? "EXT_disjoint_timer_query_webgl2"
                : "EXT_disjoint_timer_query"
        );
        api = !ext
            ? undefined
            : renderer.capabilities.isWebGL2
              ? {
                    create: () => gl.createQuery(),
                    begin: q => gl.beginQuery(ext.TIME_ELAPSED_EXT, q),
                    end: () => gl.endQuery(ext.TIME_ELAPSED_EXT),
                    available: q => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE),
                    result: q => gl.getQueryParameter(q, gl.QUERY_RESULT),
                    remove: q => gl.deleteQuery(q),
                    disjoint: () => gl.getParameter(ext.GPU_DISJOINT_EXT)
                }
              : {
                    create: () => ext.createQueryEXT(),
                    begin: q => ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, q),
                    end: () => ext.endQueryEXT(ext.TIME_ELAPSED_EXT),
                    available: q => ext.getQueryObjectEXT(q, ext.QUERY_RESULT_AVAILABLE_EXT),
                    result: q => ext.getQueryObjectEXT(q, ext.QUERY_RESULT_EXT),
                    remove: q => ext.deleteQueryEXT(q),
                    disjoint: () => gl.getParameter(ext.GPU_DISJOINT_EXT)
                };
    }
    const record = (target, name, ms) => {
        if (!Number.isFinite(ms) || ms < 0) return;
        const values = (target[name] ||= []);
        values.push(ms);
        if (values.length > 60) values.shift();
    };
    function poll() {
        if (!api || gl.isContextLost()) return;
        if (api.disjoint()) {
            for (const item of pending) api.remove(item.query);
            pending = [];
            completed.clear();
            for (const name of Object.keys(gpu)) delete gpu[name];
            return;
        }
        pending = pending.filter(item => {
            if (!api.available(item.query)) return true;
            const ms = api.result(item.query) / 1e6;
            record(gpu, item.name, ms);
            completed.set(item.frame, (completed.get(item.frame) || 0) + ms);
            api.remove(item.query);
            return false;
        });
        for (const [id, total] of completed) {
            if (pending.some(item => item.frame === id)) continue;
            record(gpu, "frame", total);
            gpuSample++;
            completed.delete(id);
        }
    }
    const original = renderer.render;
    function render(scene, camera) {
        if (disposed || depth || frame % 6 !== 0) return original.call(renderer, scene, camera);
        const name = scene.userData.earthPass || "scene";
        const query =
            api && frame % 6 === 0 && pending.length < 24 && !gl.isContextLost()
                ? api.create()
                : undefined;
        const start = performance.now();
        depth++;
        if (query) api.begin(query);
        try {
            return original.call(renderer, scene, camera);
        } finally {
            if (query) {
                api.end();
                pending.push({ query, name, frame });
            }
            depth--;
            record(cpu, name, performance.now() - start);
        }
    }
    const begin = () => {
        poll();
        frame++;
        started = performance.now();
    };
    const end = () => {
        if (frame % 6 === 0) record(cpu, "frame", performance.now() - started);
    };
    const lost = () => {
        pending = [];
        api = undefined;
        completed.clear();
        for (const name of Object.keys(gpu)) delete gpu[name];
    };
    initialize();
    renderer.render = render;
    map.addEventListener("render", begin);
    map.addEventListener("didrender", end);
    map.canvas.addEventListener("webglcontextlost", lost);
    map.canvas.addEventListener("webglcontextrestored", initialize);
    function summary(target) {
        return Object.fromEntries(
            Object.entries(target).map(([name, values]) => {
                const ordered = [...values].sort((a, b) => a - b);
                return [
                    name,
                    {
                        samples: values.length,
                        mean: values.reduce((a, b) => a + b, 0) / values.length,
                        median: ordered[Math.floor(ordered.length / 2)],
                        p95: ordered[Math.floor(ordered.length * 0.95)]
                    }
                ];
            })
        );
    }
    return {
        snapshot: () => ({
            gpuSupported: !!api,
            pending: pending.length,
            cpu: summary(cpu),
            gpu: summary(gpu)
        }),
        reset() {
            if (api && !gl.isContextLost()) for (const item of pending) api.remove(item.query);
            pending = [];
            completed.clear();
            for (const target of [cpu, gpu])
                for (const name of Object.keys(target)) delete target[name];
        },
        get gpuSupported() {
            return !!api;
        },
        get gpuSample() {
            return gpuSample;
        },
        gpuFrameMs() {
            const values = gpu.frame;
            return values?.length >= 4 ? values[values.length - 1] : undefined;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (renderer.render === render) renderer.render = original;
            map.removeEventListener("render", begin);
            map.removeEventListener("didrender", end);
            map.canvas.removeEventListener("webglcontextlost", lost);
            map.canvas.removeEventListener("webglcontextrestored", initialize);
            if (api && !gl.isContextLost()) for (const item of pending) api.remove(item.query);
            pending = [];
            completed.clear();
        }
    };
}
const levels = [
    { pixels: 1200000, idleFps: 6, activeFps: 30, cloudPixels: 130000, cloudSteps: 24 },
    { pixels: 900000, idleFps: 4, activeFps: 24, cloudPixels: 80000, cloudSteps: 20 },
    { pixels: 700000, idleFps: 3, activeFps: 15, cloudPixels: 50000, cloudSteps: 16 }
];
function createQualityController() {
    let level = 0,
        started,
        changed = -Infinity,
        average = 0,
        slow = 0,
        fast = 0;
    return {
        get current() {
            return levels[level];
        },
        get level() {
            return level;
        },
        observe({ now, cpuMs, gpuMs, ready, active }) {
            if (!ready) {
                started = undefined;
                return false;
            }
            if (started === undefined) started = now;
            // Exclude initial uploads and shader compilation; require sustained pressure.
            if (now - started < 3000) return false;
            const load = Math.max(cpuMs / 14, gpuMs === undefined ? 0 : gpuMs / (active ? 20 : 8));
            average = average ? average * 0.85 + load * 0.15 : load;
            slow = average > 1 ? slow + 1 : 0;
            fast = average < 0.45 ? fast + 1 : 0;
            let next = level;
            if (slow >= 8 && now - changed > 5000) next = Math.min(level + 1, levels.length - 1);
            if (fast >= 90 && now - changed > 30000) next = Math.max(level - 1, 0);
            if (next === level) return false;
            level = next;
            changed = now;
            slow = fast = 0;
            return true;
        },
        suspend() {
            started = undefined;
            slow = fast = 0;
            average = 0;
        }
    };
}
// Adjust only the scene render target while navigating. The native canvas,
// terrain LOD and CSS controls retain their settled resolution. Count distinct
// asynchronous GPU samples, so a single slow frame cannot cause a downgrade.
function createNavigationQuality(map, profiler) {
    const scales = [1, 0.8, 0.65, 0.5];
    let level = 0,
        lastSample = -1,
        lastChange = -Infinity,
        slow = 0,
        fast = 0,
        previousMovement = -Infinity;
    const cadence = require("./frame-cadence").createFrameCadence();
    let raf, previousTick, lastFrame;
    function stopCadence() {
        if (raf !== undefined) cancelAnimationFrame(raf);
        raf = previousTick = lastFrame = undefined;
        level = cadence.reset(level);
    }
    function tick(now) {
        raf = undefined;
        if (!map.cameraIsMoving || document.hidden || profiler.gpuSupported) {
            stopCadence();
            return;
        }
        // A user pausing between input events is not a slow renderer.
        if (previousTick !== undefined && lastFrame !== map.frameNumber)
            level = cadence.observe(now, now - previousTick, level, scales.length - 1);
        previousTick = now;
        lastFrame = map.frameNumber;
        raf = requestAnimationFrame(tick);
    }
    function observe(now) {
        if (!map.cameraIsMoving || document.hidden) {
            if (raf !== undefined) stopCadence();
            if (map.dynamicPixelRatio !== undefined) map.dynamicPixelRatio = undefined;
            slow = fast = 0;
            return;
        }
        if (now - previousMovement > 15000) level = 0;
        previousMovement = now;
        const ms = profiler.gpuFrameMs();
        if (profiler.gpuSupported === false) {
            if (raf === undefined) raf = requestAnimationFrame(tick);
        } else if (ms === undefined) level = 0;
        else if (profiler.gpuSample !== lastSample) {
            lastSample = profiler.gpuSample;
            slow = ms > 21 ? slow + 1 : 0;
            fast = ms < 9 ? fast + 1 : 0;
            let next = level;
            if (slow >= 3 && now - lastChange > 650) next = Math.min(scales.length - 1, level + 1);
            if (fast >= 12 && now - lastChange > 2500) next = Math.max(0, level - 1);
            if (next !== level) {
                level = next;
                lastChange = now;
                slow = fast = 0;
            }
        }
        const ratio = level
            ? Math.min(map.pixelRatio, Math.max(0.5, map.pixelRatio * scales[level]))
            : undefined;
        if (ratio !== map.dynamicPixelRatio) map.dynamicPixelRatio = ratio;
    }
    return { observe, dispose: stopCadence };
}
module.exports = { createProfiler, createQualityController, createNavigationQuality };
