// Estimate visibility of a finite light disk from the lake surface using DEMs
// already in memory. The elevation sampler handles the date line and poles.
function diskVisibility(x, y, waterHeight, light, sampleHeight) {
    const lon = (x - 0.5) * 2 * Math.PI,
        lat = Math.atan(Math.sinh((0.5 - y) * 2 * Math.PI));
    const co = Math.cos(lon),
        si = Math.sin(lon),
        cl = Math.cos(lat),
        sl = Math.sin(lat);
    const height = cl * co * light.x + cl * si * light.y + sl * light.z;
    if (height <= -0.007) return 0;
    if (height > 0.55) return 1;
    const bearing = Math.atan2(
        -si * light.x + co * light.y,
        -sl * co * light.x - sl * si * light.y + cl * light.z
    );
    let horizon = 0;
    for (let distance = 90; distance < 25000; distance *= 1.48) {
        const arc = distance / 6378137;
        const la = Math.asin(sl * Math.cos(arc) + cl * Math.sin(arc) * Math.cos(bearing));
        const lo =
            lon +
            Math.atan2(Math.sin(bearing) * Math.sin(arc) * cl, Math.cos(arc) - sl * Math.sin(la));
        const sample = sampleHeight(
            (lo / (2 * Math.PI) + 1.5) % 1,
            0.5 - Math.asinh(Math.tan(la)) / (2 * Math.PI)
        );
        const slope = (sample - waterHeight - (distance * distance) / 12756274) / distance;
        horizon = Math.max(horizon, Math.atan(slope));
    }
    // Include the finite solar/lunar disk and soften uncertain low-LOD ridge heights.
    const visibility = Math.max(0, Math.min(1, (Math.asin(height) - horizon + 0.01) / 0.02));
    return visibility * visibility * (3 - 2 * visibility);
}
module.exports = { diskVisibility };
