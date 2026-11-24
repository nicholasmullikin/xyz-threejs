const R = 6378137;
function clipPlanes() {
    return {
        minElevation: -500,
        maxElevation: 9000,
        evaluateClipPlanes(camera) {
            const height = Math.max(0, camera.position.length() - R),
                peak = Math.max(0, this.maxElevation);
            const horizon = Math.sqrt(height * (2 * R + height)) + Math.sqrt(peak * (2 * R + peak));
            const far = Math.max(80000, horizon * 1.12 + 20000);
            const near = Math.max(0.5, Math.min(10000, (height - peak) * 0.08));
            return { near, far, minimum: 0.5, maximum: far };
        }
    };
}
function transform(child, parent) {
    const scale = 2 ** (parent.z - child.z);
    return [scale, scale, child.x * scale - parent.x, 1 - (child.y + 1) * scale + parent.y];
}
function retryDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms);
        function done() {
            signal?.removeEventListener("abort", abort);
            resolve();
        }
        function abort() {
            clearTimeout(timer);
            reject(new DOMException("Cancelled", "AbortError"));
        }
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
    });
}
const { retryDelay: responseDelay } = require("./imagery-backoff");
async function fetchTerrain(tileKey, token, signal, repair = false) {
    const { level: z, column: x, row: y } = tileKey;
    const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${token}`;
    for (let attempt = 0; ; attempt++) {
        let retry = true;
        try {
            const response = await fetch(url, { signal, cache: repair ? "reload" : "default" });
            if (response.ok) {
                const bytes = await response.arrayBuffer();
                if (bytes.byteLength) return bytes;
                retry = false;
                throw Error("Empty terrain raster");
            }
            // Terrain-RGB omits all-water tiles. No PNG synthesis or decompression is needed.
            if (response.status === 404) return { kind: "empty-ocean-dem" };
            const retryMs = responseDelay(response.headers, response.status);
            retry = (response.status === 408 || response.status >= 500) && retryMs === undefined;
            throw Object.assign(new Error(`Terrain request failed: HTTP ${response.status}`), {
                status: response.status,
                retryMs
            });
        } catch (error) {
            if (
                signal?.aborted ||
                error?.name === "AbortError" ||
                !retry ||
                globalThis.navigator?.onLine === false ||
                attempt >= 2
            )
                throw error;
            await retryDelay(300 * 2 ** attempt, signal);
        }
    }
}
function triangleHeight(h00, h10, h01, h11, x, y) {
    return x + y <= 1
        ? h00 * (1 - x - y) + h10 * x + h01 * y
        : h11 * (x + y - 1) + h01 * (1 - x) + h10 * (1 - y);
}

module.exports = { R, clipPlanes, transform, fetchTerrain, triangleHeight };
