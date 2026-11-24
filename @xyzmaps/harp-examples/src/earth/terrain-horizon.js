const RADIUS = 6378137;
const WIDTH = 33;
const HALF_SPAN = 16000;
const CLEAR = -16000;

function horizonRegion(latitude, longitude, sun) {
    const lat = (latitude * Math.PI) / 180,
        lon = (longitude * Math.PI) / 180;
    const sl = Math.sin(lat),
        cl = Math.cos(lat),
        so = Math.sin(lon),
        co = Math.cos(lon);
    const east = -sun.x * so + sun.y * co;
    const north = -sun.x * sl * co - sun.y * sl * so + sun.z * cl;
    const up = sun.x * cl * co + sun.y * cl * so + sun.z * sl;
    const flat = Math.hypot(east, north);
    if (!(up > 0.035 && up < 0.46 && cl > 0.08 && flat > 0)) return;
    const meters = 2 * Math.PI * RADIUS * cl;
    return {
        x: (longitude + 180) / 360,
        y: (1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2,
        span: HALF_SPAN / meters,
        dx: east / (flat * meters),
        dy: -north / (flat * meters),
        slope: up / flat,
        azimuth: Math.atan2(east, north)
    };
}

const distances = Array.from({ length: 28 }, (_, i) => 2300 * (37000 / 2300) ** (i / 27));
function horizonField(region, height) {
    const data = new Float32Array(WIDTH * WIDTH);
    for (let row = 0; row < WIDTH; row++) {
        const y = region.y + ((2 * row) / (WIDTH - 1) - 1) * region.span;
        for (let col = 0; col < WIDTH; col++) {
            const x = region.x + ((2 * col) / (WIDTH - 1) - 1) * region.span;
            let blocker = CLEAR;
            for (const distance of distances) {
                const z = height(x + region.dx * distance, y + region.dy * distance);
                // Height of the shadow ray at the receiver, including Earth curvature.
                blocker = Math.max(
                    blocker,
                    z - distance * region.slope - (distance * distance) / (2 * RADIUS)
                );
            }
            data[row * WIDTH + col] = blocker;
        }
    }
    return data;
}

function wrappedDelta(a, b) {
    const dx = a - b;
    return dx - Math.round(dx);
}
function covers(field, key) {
    if (!field || key.level < 10) return false;
    const n = 2 ** key.level;
    return (
        Math.abs(wrappedDelta((key.column + 0.5) / n, field.x)) <= field.span + 0.5 / n &&
        Math.abs((key.row + 0.5) / n - field.y) <= field.span + 0.5 / n
    );
}
function encodeHorizon(data) {
    const rgba = new Uint8Array(data.length * 4);
    for (let i = 0; i < data.length; i++) {
        const h = Math.round(Math.min(1, Math.max(0, (data[i] + 2000) / 12000)) * 65535);
        rgba[i * 4] = h >>> 8;
        rgba[i * 4 + 1] = h & 255;
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}
module.exports = {
    WIDTH,
    HALF_SPAN,
    horizonRegion,
    horizonField,
    wrappedDelta,
    covers,
    encodeHorizon
};
