// Share links carry only public pack URLs and a bounded numeric camera pose.
function terrainPackUrl(value, page) {
    if (!value) return;
    try {
        const base = new URL(page),
            url = new URL(value, base);
        if (url.username || url.password) return;
        if (url.protocol === "https:" || (base.protocol === "http:" && url.protocol === "http:"))
            return url;
    } catch {
        // A malformed optional pack leaves the worldwide renderer available.
    }
}

function cameraPose(value) {
    if (!value) return;
    const parts = value.split(",");
    if (parts.length !== 6 || parts.some(p => !p.trim())) return;
    const [latitude, longitude, altitude, distance, tilt, heading] = parts.map(Number);
    if (
        ![latitude, longitude, altitude, distance, tilt, heading].every(Number.isFinite) ||
        latitude < -85 ||
        latitude > 85 ||
        longitude < -180 ||
        longitude > 180 ||
        altitude < -500 ||
        altitude > 9000 ||
        distance < 20 ||
        distance > 40000000 ||
        tilt < 0 ||
        tilt > 89
    )
        return;
    return {
        target: { latitude, longitude, altitude },
        distance,
        tilt,
        heading: ((heading % 360) + 360) % 360
    };
}
module.exports = { terrainPackUrl, cameraPose };
