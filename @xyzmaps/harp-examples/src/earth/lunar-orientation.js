// IAU 2009 lunar rotation terms from NASA NAIF pck00011. Angles are degrees.
const terms = [
    [125.045, -0.0529921, -3.8787, 1.5419, 3.561],
    [250.089, -0.1059842, -0.1204, 0.0239, 0.1208],
    [260.008, 13.0120009, 0.07, -0.0278, -0.0642],
    [176.625, 13.3407154, -0.0172, 0.0068, 0.0158],
    [357.529, 0.9856003000000001, 0.0, 0.0, 0.0252],
    [311.589, 26.405708399999998, 0.0072, -0.0029, -0.0066],
    [134.963, 13.064993, 0.0, 0.0009, -0.0047],
    [276.617, 0.3287146, 0.0, 0.0, -0.0046],
    [34.226, 1.7484876999999999, 0.0, 0.0, 0.0028],
    [15.134, -0.15897630000000001, -0.0052, 0.0008, 0.0052],
    [119.743, 0.0036096, 0.0, 0.0, 0.004],
    [239.961, 0.1643573, 0.0, 0.0, 0.0019],
    [25.053, 12.959008800000001, 0.0043, -0.0009, -0.0044]
];
function lunarOrientation(utc, sidereal, matrix) {
    const rad = Math.PI / 180,
        d = (utc - Date.UTC(2000, 0, 1, 12)) / 86400000,
        T = d / 36525;
    let ra = 269.9949 + 0.0031 * T,
        dec = 66.5392 + 0.013 * T,
        rotation = 38.3213 + 13.17635815 * d - 1.4e-12 * d * d;
    for (const [base, rate, ar, dr, wr] of terms) {
        const angle = (base + rate * d) * rad;
        ra += ar * Math.sin(angle);
        dec += dr * Math.cos(angle);
        rotation += wr * Math.sin(angle);
    }
    const a = ra * rad,
        b = dec * rad,
        c = Math.cos(a),
        s = Math.sin(a),
        u = Math.cos(b),
        v = Math.sin(b);
    const cw = Math.cos(rotation * rad),
        sw = Math.sin(rotation * rad);
    // NAIF expresses these axes in J2000. The low-cost ephemeris uses
    // equatorial coordinates of date. Apply IAU 1976 precession to each
    // body axis before rotating it into the globe's Earth-fixed frame.
    const arcsec = rad / 3600;
    const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * arcsec;
    const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * arcsec - sidereal;
    const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * arcsec;
    const cz = Math.cos(z),
        sz = Math.sin(z),
        ct = Math.cos(theta),
        st = Math.sin(theta);
    const ca = Math.cos(zeta),
        sa = Math.sin(zeta);
    function ofDate(x, y, z) {
        const p = x * ca - y * sa,
            q = x * sa + y * ca,
            r = p * ct - z * st;
        return [r * cz - q * sz, r * sz + q * cz, p * st + z * ct];
    }
    return matrix.set(
        ...ofDate(-cw * s - sw * c * v, cw * c - sw * s * v, sw * u),
        ...ofDate(sw * s - cw * c * v, -sw * c - cw * s * v, cw * u),
        ...ofDate(c * u, s * u, v)
    );
}
module.exports = { lunarOrientation };
