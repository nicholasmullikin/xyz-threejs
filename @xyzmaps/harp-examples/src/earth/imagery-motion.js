/** Motion in viewport heights / second at the actual visible DEM surface.
 * Camera translation alone treats an orbit around a fixed target as a pan.
 * Reprojecting a handful of feedback samples includes translation, rotation,
 * changing FOV and the much faster apparent motion of nearby terrain.
 */
function screenVelocity(samples, previousClipFromEye, projection, aspect, milliseconds) {
    if (!samples.length || milliseconds <= 0 || milliseconds > 650) return 0;
    const m = previousClipFromEye.elements,
        p = projection.elements,
        speeds = [];
    const step = Math.max(1, Math.floor(samples.length / 24));
    for (let i = 0; i < samples.length; i += step) {
        const s = samples[i],
            z = -s.depth;
        const x = ((s.ndcX + p[8]) * s.depth) / p[0],
            y = ((s.ndcY + p[9]) * s.depth) / p[5];
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (w <= 0) {
            speeds.push(8);
            continue;
        }
        const ox = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
        const oy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
        speeds.push(
            Math.min(8, (500 * Math.hypot((ox - s.ndcX) * aspect, oy - s.ndcY)) / milliseconds)
        );
    }
    speeds.sort((a, b) => a - b);
    return speeds[Math.floor(speeds.length * 0.6)];
}
module.exports = { screenVelocity };
