const ZOOM = 13,
    GRID = 2 ** ZOOM;
function nearest(points, mx, my, metres, limit) {
    const list = [];
    for (const [id, record] of points) {
        const x = id % GRID,
            y = Math.floor(id / GRID);
        for (let i = 0; i < record.length; i += 2) {
            const u = (x + (record[i] + 0.5) / 65536) / GRID,
                v = (y + (record[i + 1] + 0.5) / 65536) / GRID;
            const dx = u - mx - Math.round(u - mx),
                dy = v - my;
            const r2 = (dx * dx + dy * dy) * metres * metres;
            if (r2 < 1770 ** 2) list.push({ mx: u, my: v, r2, record, index: i, id });
        }
    }
    if (list.length > limit) {
        list.sort((a, b) => a.r2 - b.r2);
        list.length = limit;
    }
    return list;
}
function streetLights(THREE, map, sky, env, height, small) {
    const instanced =
        map.renderer.capabilities.isWebGL2 || map.renderer.extensions.has("ANGLE_instanced_arrays");
    const stats = {
        enabled: false,
        supported: instanced,
        fixtures: 0,
        records: 0,
        bytes: 0,
        failures: 0
    };
    const uniforms = { fade: { value: 0 }, viewportHeight: { value: 1 } };
    const records = new Map(),
        up = new THREE.Vector3(),
        size = new THREE.Vector2();
    let API,
        pending,
        read,
        mesh,
        timer,
        drawTimer,
        abort,
        lastPlan = "",
        lastDraw = "",
        revision = 0,
        disposed = false,
        retry = 0;
    function stop() {
        clearTimeout(timer);
        clearTimeout(drawTimer);
        drawTimer = undefined;
        timer = undefined;
        abort?.abort();
        abort = undefined;
        records.clear();
        mesh?.dispose();
        mesh = undefined;
        read = undefined;
        lastDraw = lastPlan = "";
        stats.fixtures = stats.records = stats.bytes = 0;
    }
    function plan(keys, key) {
        clearTimeout(timer);
        abort?.abort();
        const task = new AbortController();
        abort = task;
        lastPlan = key;
        const needed = new Set(keys);
        for (const id of records.keys()) if (!needed.has(id)) records.delete(id);
        timer = setTimeout(async () => {
            try {
                read ??= API.mappedLamps();
                const missing = keys.filter(id => !records.has(id));
                let i = 0;
                await Promise.all(
                    Array.from({ length: Math.min(2, missing.length) }, async () => {
                        while (i < missing.length && !task.signal.aborted) {
                            const id = missing[i++],
                                data = await read(id % GRID, Math.floor(id / GRID), task.signal);
                            if (task.signal.aborted) return;
                            records.set(id, data);
                            revision++;
                            map.update();
                        }
                    })
                );
            } catch {
                if (!task.signal.aborted) {
                    stats.failures++;
                    retry = performance.now() + 30000;
                    lastPlan = "";
                    timer = setTimeout(() => map.update(), 30010);
                }
            }
        }, 180);
    }
    let nextGroundRefresh = 0;
    function update(mode) {
        if (!stats.enabled) return;
        const pos = map.camera.position;
        const day = up.copy(pos).normalize().dot(sky.uniforms.sunDirection.value);
        if (
            mode !== "a" ||
            document.hidden ||
            !env.uniforms.lightsEnabled.value ||
            day > 0.025 ||
            map.targetDistance > 4100
        ) {
            if (lastPlan || mesh) stop();
            return;
        }
        if (!API) {
            if (!pending && performance.now() >= retry)
                pending = import(
                    /* webpackChunkName:"earth-street-lights" */ "./street-light-catalog"
                )
                    .then(m => {
                        API = m;
                        if (!disposed) map.update();
                    })
                    .catch(() => {
                        retry = performance.now() + 30000;
                    })
                    .finally(() => {
                        pending = undefined;
                    });
            return;
        }
        const geo = map.projection.unprojectPoint(pos),
            lat = (geo.latitude * Math.PI) / 180;
        if (Math.abs(geo.latitude) > 85) {
            if (lastPlan || mesh) stop();
            return;
        }
        const meters = 40075016.68558 * Math.cos(lat),
            mx = (geo.longitude + 180) / 360,
            my = (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2;
        const x = Math.floor(mx * GRID),
            y = Math.floor(my * GRID);
        // Fetch only records intersecting the local light radius, including across ±180°.
        const half = 1770 / meters,
            keys = [];
        const radius = Math.min(2, Math.ceil(half * GRID));
        for (let ty = Math.max(0, y - radius); ty <= Math.min(GRID - 1, y + radius); ty++)
            for (let tx = x - radius; tx <= x + radius; tx++) {
                if (
                    tx + 1 < (mx - half) * GRID ||
                    tx > (mx + half) * GRID ||
                    ty + 1 < (my - half) * GRID ||
                    ty > (my + half) * GRID
                )
                    continue;
                keys.push(ty * GRID + (((tx % GRID) + GRID) % GRID));
            }
        const key = keys.join(",");
        if (key !== lastPlan && performance.now() >= retry) plan(keys, key);
        uniforms.fade.value =
            (1 - THREE.MathUtils.smoothstep(day, -0.15, 0.025)) *
            (1 - THREE.MathUtils.smoothstep(map.targetDistance, 2600, 4100));
        uniforms.viewportHeight.value = map.renderer.getDrawingBufferSize(size).y;
        const ground = keys.map(id =>
            height.revisionForTile(id % GRID, Math.floor(id / GRID), ZOOM)
        );
        const draw = [
            revision,
            Math.floor(mx * GRID * 48),
            Math.floor(my * GRID * 48),
            ground
        ].join("/");
        if (lastDraw === draw) return;
        if (performance.now() < nextGroundRefresh) {
            if (!drawTimer)
                drawTimer = setTimeout(
                    () => {
                        drawTimer = undefined;
                        if (!disposed) map.update();
                    },
                    nextGroundRefresh - performance.now() + 1
                );
            return;
        }
        nextGroundRefresh = performance.now() + 220;
        const selected = nearest(records, mx, my, meters, small ? 380 : 850);
        if (selected.length || mesh) {
            mesh ??= require("./street-light-mesh").streetLightMesh(
                THREE,
                map,
                height,
                small ? 380 : 850,
                uniforms
            );
            mesh.update(
                selected,
                { latitude: geo.latitude, longitude: geo.longitude, altitude: 0 },
                new Map(keys.map((id, i) => [id, ground[i]]))
            );
        }
        stats.fixtures = selected.length;
        stats.records = records.size;
        stats.bytes = 0;
        for (const data of records.values()) stats.bytes += data.byteLength;
        lastDraw = draw;
    }
    function visibility() {
        if (document.hidden) stop();
        else if (stats.enabled) map.update();
    }
    function setEnabled(value) {
        stats.enabled = !!value && instanced;
        document.removeEventListener("visibilitychange", visibility);
        if (stats.enabled) document.addEventListener("visibilitychange", visibility);
        else stop();
        if (!disposed) map.update();
    }
    return {
        stats,
        update,
        setEnabled,
        dispose() {
            disposed = true;
            setEnabled(false);
        }
    };
}
module.exports = { nearest, streetLights };
