// Low precision equatorial coordinates of date. Distances are in kilometres.
// Solar solution: USNO, "Computing Approximate Solar Coordinates".
// Lunar elements and short-period perturbations: Paul Schlyter, ppcomp.html.
const DEG = Math.PI / 180;
const sin = angle => Math.sin(angle * DEG);
const cos = angle => Math.cos(angle * DEG);
const unixJ2000 = Date.UTC(2000, 0, 1, 12);
const dayMs = 86400000;
function equatorial(longitude, latitude, obliquity) {
    const x = cos(longitude) * cos(latitude);
    const y = sin(longitude) * cos(latitude);
    const z = sin(latitude);
    return {
        ra: Math.atan2(y * cos(obliquity) - z * sin(obliquity), x),
        dec: Math.asin(y * sin(obliquity) + z * cos(obliquity))
    };
}
function solar(days) {
    const anomaly = 357.529 + 0.98560028 * days;
    const mean = 280.459 + 0.98564736 * days;
    const longitude = mean + 1.915 * sin(anomaly) + 0.02 * sin(2 * anomaly);
    const obliquity = 23.439 - 0.00000036 * days;
    const distanceAU = 1.00014 - 0.01671 * cos(anomaly) - 0.00014 * cos(2 * anomaly);
    return {
        ...equatorial(longitude, 0, obliquity),
        radius: (0.2666 * DEG) / distanceAU,
        mean,
        anomaly,
        obliquity
    };
}
function ephemeris(utc) {
    const days = (utc - unixJ2000) / dayMs;
    const sun = solar(days);
    const d = days + 1.5; // lunar elements at 1999 Dec 31 00:00 UT
    const node = 125.1228 - 0.0529538083 * d;
    const periapsis = 318.0634 + 0.1643573223 * d;
    const anomaly = 115.3654 + 13.0649929509 * d;
    const ecc = 0.0549;
    const meanAnomaly = (anomaly % 360) * DEG;
    let eccentricAnomaly = meanAnomaly;
    for (let i = 0; i < 3; i++)
        eccentricAnomaly -=
            (eccentricAnomaly - ecc * Math.sin(eccentricAnomaly) - meanAnomaly) /
            (1 - ecc * Math.cos(eccentricAnomaly));
    const vx = Math.cos(eccentricAnomaly) - ecc,
        vy = Math.sqrt(1 - ecc * ecc) * Math.sin(eccentricAnomaly);
    const argument = Math.atan2(vy, vx) / DEG + periapsis;
    const x = cos(node) * cos(argument) - sin(node) * sin(argument) * cos(5.1454);
    const y = sin(node) * cos(argument) + cos(node) * sin(argument) * cos(5.1454);
    const z = sin(argument) * sin(5.1454);
    const meanMoon = anomaly + periapsis + node,
        elongation = meanMoon - sun.mean;
    const f = meanMoon - node,
        m = anomaly,
        s = sun.anomaly,
        e = elongation;
    const longitude =
        Math.atan2(y, x) / DEG -
        1.274 * sin(m - 2 * e) +
        0.658 * sin(2 * e) -
        0.186 * sin(s) -
        0.059 * sin(2 * m - 2 * e) -
        0.057 * sin(m - 2 * e + s) +
        0.053 * sin(m + 2 * e) +
        0.046 * sin(2 * e - s) +
        0.041 * sin(m - s) -
        0.035 * sin(e) -
        0.031 * sin(m + s) -
        0.015 * sin(2 * f - 2 * e) +
        0.011 * sin(m - 4 * e);
    const latitude =
        Math.asin(z) / DEG -
        0.173 * sin(f - 2 * e) -
        0.055 * sin(m - f - 2 * e) -
        0.046 * sin(m + f - 2 * e) +
        0.033 * sin(f + 2 * e) +
        0.017 * sin(2 * m + f);
    const distance =
        6378.137 * (60.2666 * Math.hypot(vx, vy) - 0.58 * cos(m - 2 * e) - 0.46 * cos(2 * e));
    return {
        sun,
        moon: { ...equatorial(longitude, latitude, sun.obliquity), distance },
        sidereal: ((280.46061837 + 360.98564736629 * days) % 360) * DEG
    };
}
// Map the slider's apparent solar hour to UT. Preserve its reference longitude
// while the actual date determines the season, lunar phase and angular radii.
const referenceLongitude = -112.15;
function solarUtc(midnight, hour) {
    const meanTime = midnight + (hour - referenceLongitude / 15) * 3600000;
    const sun = solar((meanTime - unixJ2000) / dayMs);
    const equation = ((((sun.mean - sun.ra / DEG + 180) % 360) + 360) % 360) - 180;
    return meanTime - (equation / 360) * dayMs;
}
function direction(target, body, sidereal) {
    const lon = body.ra - sidereal,
        c = Math.cos(body.dec);
    return target.set(c * Math.cos(lon), c * Math.sin(lon), Math.sin(body.dec));
}
module.exports = { ephemeris, solarUtc, direction, referenceLongitude };
