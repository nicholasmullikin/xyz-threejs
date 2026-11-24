const { createLazPerf } = require("laz-perf/lib/web");
const { tileFrame, surveyAt, possibleNodes, createRaster } = require("./lidar-grid");
const { surveyBudget } = require("./survey-budget");
const cache = new Map();
let cacheBytes = 0,
    budget,
    decoder,
    active;
const origin = "https://usgs-lidar-public.s3.us-west-2.amazonaws.com/";
function remember(url, bytes) {
    cache.set(url, bytes);
    cacheBytes += bytes.byteLength;
    while (cacheBytes > 14 * 1024 * 1024 || cache.size > 96) {
        const key = cache.keys().next().value;
        cacheBytes -= cache.get(key).byteLength;
        cache.delete(key);
    }
}
function pause(ms, signal) {
    return new Promise((resolve, reject) => {
        const finish = () => {
                signal.removeEventListener("abort", cancel);
                resolve();
            },
            timer = setTimeout(finish, ms);
        function cancel() {
            clearTimeout(timer);
            reject(new DOMException("Cancelled", "AbortError"));
        }
        signal.addEventListener("abort", cancel, { once: true });
    });
}
async function read(url, ctx, expected) {
    const cached = cache.get(url);
    if (cached) {
        cache.delete(url);
        cache.set(url, cached);
        return cached;
    }
    while (!budget.reserve(expected)) {
        if (ctx.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        await pause(Math.min(10000, budget.delay(expected)), ctx.signal);
    }
    try {
        const response = await fetch(url, { signal: ctx.signal });
        if (!response.ok) throw Error("LiDAR source HTTP " + response.status);
        const bytes = await response.arrayBuffer();
        budget.pay(bytes.byteLength);
        ctx.bytes += bytes.byteLength;
        self.postMessage({ id: ctx.id, spent: bytes.byteLength });
        remember(url, bytes);
        return bytes;
    } finally {
        budget.release(expected);
    }
}
const decodeJSON = bytes => JSON.parse(new TextDecoder().decode(bytes));
const json = async (url, ctx) => decodeJSON(await read(url, ctx, 40000));
async function sourceName(frame, ctx) {
    const lon = (frame.lon * 180) / Math.PI,
        lat = (frame.lat * 180) / Math.PI,
        x = Math.floor(lon / 5),
        y = Math.floor(lat / 5);
    const key = x + "_" + y,
        base = "/earth-data/usgs-ept/";
    const index = await json(base + "index.json", ctx);
    if (!index.cells.includes(key)) return;
    return surveyAt(
        await json(base + key + ".json", ctx),
        (lon - 5 * x) * 10000,
        (lat - 5 * y) * 10000
    );
}
async function sample(bytes, frame, raster, tops, ctx) {
    decoder ??= createLazPerf({
        locateFile: () => new URL("resources/earth/laz-perf.wasm", self.location.href).href
    });
    const wasm = await decoder,
        h = new DataView(bytes),
        src = wasm._malloc(bytes.byteLength),
        reader = new wasm.LASZip();
    let dest = 0;
    try {
        wasm.HEAPU8.set(new Uint8Array(bytes), src);
        reader.open(src, bytes.byteLength);
        const count = reader.getCount(),
            stride = reader.getPointLength(),
            modern = reader.getPointFormat() >= 6;
        dest = wasm._malloc(stride);
        let p = new DataView(wasm.HEAPU8.buffer, dest, stride);
        const sx = h.getFloat64(131, true),
            sy = h.getFloat64(139, true),
            sz = h.getFloat64(147, true);
        const ox = h.getFloat64(155, true) - frame.west,
            oy = frame.north - h.getFloat64(163, true),
            oz = h.getFloat64(171, true);
        let accepted = 0;
        for (let i = 0; i < count; i++) {
            reader.getPoint(dest);
            // LASzip allocates intermediate tables lazily. Emscripten replaces
            // its ArrayBuffer when the WASM heap grows mid-stream.
            if (p.buffer !== wasm.HEAPU8.buffer) p = new DataView(wasm.HEAPU8.buffer, dest, stride);
            const classification = modern ? p.getUint8(16) : p.getUint8(15) & 31;
            // Ground, water and road surfaces can be later returns under trees.
            const ground = classification === 2 || classification === 9 || classification === 11;
            const first = (p.getUint8(14) & (modern ? 15 : 7)) === 1;
            // Classified vegetation, power lines, noise and bridges cannot
            // supply a building height. Older archives leave roofs unclassified.
            const roof =
                first && (classification === 0 || classification === 1 || classification === 6);
            if (!ground && !roof) continue;
            const u = (ox + p.getInt32(0, true) * sx) / frame.span,
                v = (oy - p.getInt32(4, true) * sy) / frame.span;
            if (u < -0.01 || u > 1.01 || v < -0.01 || v > 1.01) continue;
            const z = oz + p.getInt32(8, true) * sz;
            if (z < ctx.elevation - 130 || z > ctx.elevation + 600) continue;
            if (ground) {
                raster.add(u, v, z);
                accepted++;
            }
            if (roof) tops.add(u, v, z);
        }
        return accepted;
    } finally {
        if (dest) wasm._free(dest);
        reader.delete();
        wasm._free(src);
    }
}
async function process(tile, ctx) {
    const frame = tileFrame(tile.x, tile.y, tile.z),
        name = await sourceName(frame, ctx);
    if (!name) return;
    const base = origin + encodeURIComponent(name) + "/",
        ept = await json(base + "ept.json", ctx);
    if (String(ept.srs?.horizontal) !== "3857" || ept.dataType !== "laszip") return;
    const tables = new Map();
    async function table(key) {
        if (!tables.has(key)) tables.set(key, json(base + "ept-hierarchy/" + key + ".json", ctx));
        return tables.get(key);
    }
    async function count(node) {
        let t = await table("0-0-0-0");
        for (let d = 1; d <= node.d; d++) {
            const shift = node.d - d,
                key = [d, node.x >> shift, node.y >> shift, node.z >> shift].join("-");
            if (!(key in t)) return 0;
            if (t[key] === -1) t = await table(key);
        }
        return t[node.key] || 0;
    }
    const cells = ctx.small ? 64 : 96,
        raster = createRaster(cells),
        tops = createRaster(cells);
    const nodes = possibleNodes(ept, frame, ctx.elevation, Math.max(1.2, frame.metres / cells));
    let points = 0,
        prev = -1;
    function send(partial) {
        const mesh = raster.mesh(frame.metres, 0.22);
        if (!mesh) return;
        const samples = partial ? undefined : tops.observations();
        const transfer = [
            mesh.pos.buffer,
            mesh.normal.buffer,
            mesh.index.buffer,
            mesh.ground.buffer
        ];
        if (samples) transfer.push(samples.buffer);
        self.postMessage(
            { id: ctx.id, tile, mesh, samples, points, bytes: ctx.bytes, name, partial },
            transfer
        );
        return true;
    }
    for (const node of nodes) {
        if (ctx.signal.aborted) throw new DOMException("Cancelled", "AbortError");
        if (node.d !== prev && points > 500 && node.d === nodes.at(-1).d) send(true);
        prev = node.d;
        const amount = await count(node);
        if (amount <= 0) continue;
        const bytes = await read(
            base + "ept-data/" + node.key + ".laz",
            ctx,
            Math.min(2000000, Math.max(40000, amount * 5))
        );
        points += await sample(bytes, frame, raster, tops, ctx);
        if (ctx.bytes > (ctx.small ? 3 : 6) * 1024 * 1024) break;
    }
    return send(false);
}
self.onmessage = async ({ data }) => {
    if (data.cancel) {
        active?.abort();
        return;
    }
    active?.abort();
    const controller = new AbortController();
    active = controller;
    budget ??= surveyBudget(true, () => performance.now(), data.credit);
    const ctx = {
        id: data.id,
        signal: controller.signal,
        small: data.small,
        elevation: data.elevation,
        bytes: 0
    };
    try {
        if (!(await process(data.tile, ctx)) && !ctx.signal.aborted)
            self.postMessage({ id: ctx.id, tile: data.tile, empty: true, bytes: ctx.bytes });
    } catch (error) {
        if (!ctx.signal.aborted)
            self.postMessage({
                id: ctx.id,
                tile: data.tile,
                error: String(error.message),
                bytes: ctx.bytes
            });
    }
};
