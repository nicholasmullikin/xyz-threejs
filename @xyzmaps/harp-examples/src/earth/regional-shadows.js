const { earthWorkerUrl } = require("./worker-url");
const { WIDTH, horizonRegion, wrappedDelta, covers, encodeHorizon } = require("./terrain-horizon");
function createRegionalShadows(THREE, map, stats) {
    let worker,
        pending,
        field,
        lastUpload,
        retryAt = 0,
        updatedAt = -Infinity,
        timer;
    let previousBytes = 0;
    const center = { value: new THREE.Vector3() },
        east = { value: new THREE.Vector3() },
        south = { value: new THREE.Vector3() };
    const position = new THREE.Vector2();
    const enabled = { value: 0 };
    const uniforms = {
        regionalSunOrigin: center,
        regionalSunEast: east,
        regionalSunSouth: south,
        regionalSunEnabled: enabled
    };
    function changed(a, b, scale) {
        return (
            !a ||
            Math.abs(wrappedDelta(a.x, b.x)) + Math.abs(a.y - b.y) > b.span * scale ||
            Math.abs(a.slope - b.slope) > 0.035 * scale ||
            Math.cos(a.azimuth - b.azimuth) < 1 - 0.004 * scale
        );
    }
    function wakeIn(ms) {
        if (timer !== undefined) return;
        timer = setTimeout(() => {
            timer = undefined;
            map.update();
        }, ms);
    }
    function retryLater() {
        retryAt = performance.now() + 30000;
        wakeIn(30001);
    }
    function reset() {
        worker?.terminate();
        worker = pending = field = lastUpload = undefined;
        enabled.value = previousBytes = 0;
        clearTimeout(timer);
        timer = undefined;
        retryAt = 0;
        updatedAt = -Infinity;
        stats.regional = false;
    }
    function update(geo, sun) {
        if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function")
            return;
        const region = horizonRegion(geo.latitude, geo.longitude, sun);
        if (!region) {
            if (worker || timer !== undefined) reset();
            return;
        }
        if (field && changed(field, region, 1)) field = undefined;
        stats.regional = !!field;
        const now = performance.now();
        if (pending || !changed(field, region, 0.27)) return;
        if (now < retryAt) {
            wakeIn(Math.ceil(retryAt - now));
            return;
        }
        if (now - updatedAt < 800) {
            wakeIn(810 - (now - updatedAt));
            return;
        }
        if (!worker) {
            try {
                worker = new Worker(earthWorkerUrl("earth-horizon"));
            } catch {
                retryLater();
                return;
            }
            worker.onmessage = ({ data }) => {
                pending = false;
                if (data.heights) {
                    field = { ...data.region, pixels: encodeHorizon(data.heights) };
                    const lon = (field.x * 2 - 1) * Math.PI;
                    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * field.y)));
                    const sl = Math.sin(lat),
                        cl = Math.cos(lat),
                        so = Math.sin(lon),
                        co = Math.cos(lon);
                    center.value.set(cl * co, cl * so, sl).multiplyScalar(6378.137);
                    east.value.set(-so, co, 0);
                    south.value.set(sl * co, sl * so, -cl);
                    stats.regionalUpdates++;
                    stats.regionalBytes += data.bytes - previousBytes;
                    previousBytes = data.bytes;
                } else retryLater();
                map.update();
            };
            worker.onerror = () => {
                reset();
                retryLater();
                map.update();
            };
        }
        pending = true;
        updatedAt = now;
        worker.postMessage(region);
    }
    function upload(renderer, target, resolution) {
        enabled.value = field ? 1 : 0;
        if (!field || (lastUpload === field && field.target === target)) return;
        // The depth atlas uses its square viewport. A 33-row strip outside that
        // viewport carries one continuous horizon field for every receiver.
        const pixels = new THREE.DataTexture(field.pixels, WIDTH, WIDTH, THREE.RGBAFormat);
        position.set(0, resolution);
        renderer.copyTextureToTexture(position, pixels, target.texture);
        pixels.dispose();
        lastUpload = field;
        field.target = target;
    }
    return { update, covers: key => covers(field, key), uniforms, upload, reset };
}
module.exports = { createRegionalShadows };
