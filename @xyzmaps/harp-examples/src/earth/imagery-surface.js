const { transform } = require("./math");
const { residentPage } = require("./imagery-provider");

// A wraparound neighbour belongs to another copy of the Mercator world.
// Select its shared edge before the sampler clamps the coordinates.
function neighbourTransform(tile, entry, sides) {
    const uv = transform(tile, entry);
    const n = 2 ** entry.z;
    if (entry.z > 0) {
        if (sides[1] && tile.x === 2 ** tile.z - 1 && entry.x === 0) uv[2] -= n;
        else if (sides[0] && tile.x === 0 && entry.x === n - 1) uv[2] += n;
    }
    return uv;
}

const empty = Object.freeze({ base: null, details: Object.freeze([]) });
const MAX_LOOKUPS = 128;
function createSurfaceLookup() {
    let drawn;
    const memo = new Map();
    function reset() {
        drawn = undefined;
        memo.clear();
    }
    function index(active, cache) {
        drawn = new Map();
        function add(entry, fade) {
            if (!entry || fade <= 0 || cache.get(entry.key) !== entry || entry.key.startsWith("c:"))
                return;
            const old = drawn.get(entry.key);
            if (!old || old.fade < fade) drawn.set(entry.key, { entry, fade });
        }
        for (const state of active) {
            add(state.from.entry, 1 - state.mix);
            add(state.to.entry, state.mix);
            for (const page of state.details || [])
                add(page.entry, page.alpha * page.alpha * (3 - 2 * page.alpha));
        }
    }
    function get(tileKey, active, samples, cache) {
        const tile = { z: tileKey.level, x: tileKey.column, y: tileKey.row };
        const k = tile.z + "/" + tile.x + "/" + tile.y;
        if (memo.has(k)) return memo.get(k);
        if (!drawn) index(active, cache);
        let base = null;
        for (let z = tile.z; z >= 0; z--) {
            const scale = 2 ** (tile.z - z);
            const ref = residentPage(
                cache,
                z + "/" + Math.floor(tile.x / scale) + "/" + Math.floor(tile.y / scale)
            );
            if (ref) {
                base = {
                    texture: ref.texture,
                    uv: transform(tile, ref),
                    fade: drawn.get(ref.key)?.fade ?? 1,
                    z
                };
                break;
            }
        }
        const candidates = [];
        for (const { entry, fade } of drawn.values()) {
            if (entry.z <= tile.z) continue;
            const s = 2 ** (entry.z - tile.z);
            if (Math.floor(entry.x / s) !== tile.x || Math.floor(entry.y / s) !== tile.y) continue;
            candidates.push({ entry, fade, indices: [] });
        }
        // At a grazing angle four roofs in the foreground may occupy more
        // pixels than a much larger patch farther back. Use the same visible
        // surface samples as the terrain stream instead of ranking by tile area.
        const relevant =
            candidates.length > 4
                ? samples.filter(
                      s =>
                          Math.floor(s.mx * 2 ** tile.z) === tile.x &&
                          Math.floor(s.my * 2 ** tile.z) === tile.y
                  )
                : [];
        const levels = relevant.map(() => base?.z ?? 0);
        if (relevant.length) {
            for (const c of candidates) {
                const n = 2 ** c.entry.z;
                relevant.forEach((s, i) => {
                    if (Math.floor(s.mx * n) === c.entry.x && Math.floor(s.my * n) === c.entry.y)
                        c.indices.push(i);
                });
            }
        }
        const details = [];
        while (candidates.length && details.length < 4) {
            let which = 0,
                highest = -1;
            for (let i = 0; i < candidates.length; i++) {
                const c = candidates[i];
                let score = 2 ** (-2 * (c.entry.z - tile.z)) * 0.01;
                for (const index of c.indices) score += Math.max(0, c.entry.z - levels[index]);
                score *= c.fade;
                if (score > highest) {
                    highest = score;
                    which = i;
                }
            }
            const [c] = candidates.splice(which, 1);
            for (const i of c.indices) levels[i] = Math.max(levels[i], c.entry.z);
            details.push({
                texture: c.entry.texture,
                uv: transform(tile, c.entry),
                fade: c.fade,
                z: c.entry.z
            });
        }
        details.sort((a, b) => a.z - b.z);
        const result = !base && !details.length ? empty : { base, details };
        if (memo.size >= MAX_LOOKUPS) memo.clear();
        memo.set(k, result);
        return result;
    }
    return { get, reset, empty };
}
module.exports = { createSurfaceLookup, neighbourTransform };
