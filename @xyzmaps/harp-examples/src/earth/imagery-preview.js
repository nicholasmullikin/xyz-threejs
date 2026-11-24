const { R } = require("./math");
const { firstAvailable, residentPage } = require("./imagery-provider");

function choosePreview(map) {
    const target = map.target;
    if (
        map.zoomLevel < 8 ||
        !target ||
        Math.abs(target.latitude) > 85 ||
        !Number.isFinite(target.longitude) ||
        !map.canvas.height
    )
        return;
    const lat = (target.latitude * Math.PI) / 180;
    const u = ((((target.longitude + 180) / 360) % 1) + 1) % 1;
    const v = (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2;
    // Find a single tile that covers most of the approaching view, including
    // when its target falls near a tile corner. This intentionally serves
    // broad coverage first; the DEM feedback takes over fine requests.
    const span =
        (2 * map.targetDistance * Math.tan((map.camera.fov * Math.PI) / 360)) /
        (2 * Math.PI * R * Math.cos(lat));
    const rx = Math.max(1e-10, ((span * map.canvas.width) / map.canvas.height) * 0.5);
    const ry = Math.max(1e-10, (span * 0.5) / Math.max(0.35, Math.cos((map.tilt * Math.PI) / 180)));
    const finest = Math.max(5, Math.min(14, Math.floor(map.zoomLevel) - 3));
    let best,
        gain = -1;
    for (let z = finest; z >= Math.max(4, finest - 2); z--) {
        const n = 2 ** z,
            x = Math.floor(u * n),
            y = Math.floor(v * n);
        const fraction = (p, r, i) =>
            (Math.min((i + 1) / n, p + r) - Math.max(i / n, p - r)) / (2 * r);
        const score = fraction(u, rx, x) * fraction(v, ry, y) * (z - 3);
        if (score > gain) {
            gain = score;
            best = { z, x, y, key: z + "/" + x + "/" + y, u, v, latitude: target.latitude };
        }
    }
    return best;
}

function createPreview(map) {
    let aim,
        goal,
        active,
        started = 0,
        lastStarted = -Infinity;
    function update(mode, cache, missing, now, refresh, hasToken, fast) {
        if (mode !== "a" || !hasToken) {
            aim = goal = active = undefined;
            return;
        }
        const target = map.target;
        // Feedback is paced during navigation. A jump to a distant location
        // needs its own first image even before the next feedback pass.
        const scale = aim ? 2 ** Math.max(aim.z, Math.min(14, Math.floor(map.zoomLevel) - 4)) : 1;
        const du = target && aim ? Math.abs((target.longitude + 180) / 360 - aim.u) % 1 : 0;
        const jumped =
            aim &&
            target &&
            (Math.min(du, 1 - du) * scale > 4 ||
                Math.abs(target.latitude - aim.latitude) * scale >
                    4 * 360 * Math.cos((aim.latitude * Math.PI) / 180));
        if (refresh || !aim || jumped) aim = choosePreview(map);
        if (!aim) {
            goal = active = undefined;
            return;
        }
        const available = firstAvailable(aim, aim.z, 4, missing, now);
        if (!available) {
            goal = active = undefined;
            return;
        }
        let resident;
        for (let z = available.z; z >= 4; z--) {
            const n = 2 ** z;
            const k = z + "/" + Math.floor(aim.u * n) + "/" + Math.floor(aim.v * n);
            resident = residentPage(cache, k);
            if (resident) break;
        }
        // Keep a useful page through small camera changes. This avoids a
        // second transition in a part of the sky underlay that already has
        // recognizable imagery and costs at most one pinned texture.
        const contains =
            active &&
            Math.floor(aim.u * 2 ** active.z) === active.x &&
            Math.floor(aim.v * 2 ** active.z) === active.y;
        if (!contains || (resident && resident.z > active.z + 1)) {
            if (active !== resident) started = now;
            active = resident;
        }
        if (active && cache.get(active.key) !== active) active = undefined;
        if (resident && resident.z >= available.z - 1) {
            goal = undefined;
            return;
        }
        if (goal?.key === available.key) return goal;
        goal = undefined;
        // No new preview work for a fast fly-through. One in-flight image
        // may still finish, and ordinary terrain paging keeps progressing.
        if (jumped || (!fast && now - lastStarted >= 1200)) {
            goal = available;
            lastStarted = now;
        }
        return goal;
    }
    function get(now) {
        if (!active) return null;
        const t = Math.max(0, Math.min(1, (now - started) / 280));
        return {
            texture: active.texture,
            z: active.z,
            x: active.x,
            y: active.y,
            fade: t * t * (3 - 2 * t)
        };
    }
    return {
        update,
        get,
        get activeKey() {
            return active?.key;
        },
        dispose() {
            aim = goal = active = undefined;
        }
    };
}
module.exports = { choosePreview, createPreview };
