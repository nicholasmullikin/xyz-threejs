// Build Hillaire's isotropic higher-order scattering approximation for a
// spherical atmosphere. The GPU only reads the 2D table (solar zenith, height).
// Reference: https://sebh.github.io/publications/egsr2020.pdf
const R = 6378.137;
const rayleigh = [0.005802, 0.013558, 0.0331],
    ozone = [0.00065, 0.001881, 0.000085];
const width = 48,
    height = 24;
function generate(transmittance) {
    const { data: trans, width: tw, height: th } = transmittance;
    const data = new Uint8Array(width * height * 4);
    const rayCount = 64,
        steps = 24,
        groundAlbedo = 0.16;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    function sunlight(mu, h, c) {
        const x = Math.max(0, Math.min(tw - 1, (mu * 0.5 + 0.5) * (tw - 1)));
        const y = Math.sqrt(Math.max(0, Math.min(1, h / 100))) * (th - 1);
        const x0 = Math.min(tw - 2, Math.floor(x)),
            y0 = Math.min(th - 2, Math.floor(y));
        const fx = x - x0,
            fy = y - y0,
            i = (y0 * tw + x0) * 4 + c;
        return (
            ((trans[i] * (1 - fx) + trans[i + 4] * fx) * (1 - fy) +
                (trans[i + 4 * tw] * (1 - fx) + trans[i + 4 * tw + 4] * fx) * fy) /
            255
        );
    }
    for (let y = 0; y < height; y++) {
        const altitude = 0.001 + 100 * (y / (height - 1)) ** 2,
            r = R + altitude;
        for (let x = 0; x < width; x++) {
            const sunZ = (x / (width - 1)) * 2 - 1,
                sunX = Math.sqrt(1 - sunZ * sunZ);
            const direct = [0, 0, 0],
                feedback = [0, 0, 0];
            for (let k = 0; k < rayCount; k++) {
                const dz = 1 - (2 * (k + 0.5)) / rayCount,
                    dx = Math.sqrt(1 - dz * dz) * Math.cos(k * goldenAngle);
                const b = r * dz,
                    groundDiscriminant = b * b - altitude * (r + R);
                const ground = dz < 0 && groundDiscriminant >= 0;
                const length = ground
                    ? (altitude * (r + R)) / (-b + Math.sqrt(groundDiscriminant))
                    : -b + Math.sqrt(Math.max(0, b * b + (R + 100 - r) * (R + 100 + r)));
                const tr = [1, 1, 1],
                    endAltitude = ground ? 0 : 100;
                // The source radiance uses isotropic phase in this approximation.
                for (let i = 0; i < steps; i++) {
                    const a = i / steps,
                        b = (i + 1) / steps;
                    const nearDense = altitude < endAltitude;
                    const ta = length * (nearDense ? a * a : 1 - (1 - a) ** 2);
                    const tb = length * (nearDense ? b * b : 1 - (1 - b) ** 2);
                    const t = (ta + tb) * 0.5,
                        localR = Math.sqrt(r * r + t * t + 2 * r * t * dz);
                    const h = Math.max(0, localR - R),
                        mu = (t * dx * sunX + (r + t * dz) * sunZ) / localR;
                    const rayDensity = Math.exp(-h / 8),
                        mieDensity = Math.exp(-h / 1.2),
                        ozoneDensity = Math.max(0, 1 - Math.abs(h - 25) / 15);
                    for (let c = 0; c < 3; c++) {
                        const sigmaS = rayleigh[c] * rayDensity + 0.003996 * mieDensity;
                        const sigmaT =
                            rayleigh[c] * rayDensity +
                            0.00444 * mieDensity +
                            ozone[c] * ozoneDensity;
                        const tau = (tb - ta) * sigmaT,
                            loss = -Math.expm1(-tau),
                            weight = (tr[c] * loss * sigmaS) / sigmaT;
                        feedback[c] += weight;
                        direct[c] += (weight * sunlight(mu, h, c)) / (4 * Math.PI);
                        tr[c] *= 1 - loss;
                    }
                }
                if (ground) {
                    const mu = (length * dx * sunX + (r + length * dz) * sunZ) / R;
                    for (let c = 0; c < 3; c++) {
                        feedback[c] += tr[c] * groundAlbedo;
                        direct[c] +=
                            ((tr[c] * groundAlbedo) / Math.PI) *
                            Math.max(0, mu) *
                            sunlight(mu, 0, c);
                    }
                }
            }
            const j = (y * width + x) * 4;
            for (let c = 0; c < 3; c++) {
                const radiance = direct[c] / Math.max(0.01, rayCount - feedback[c]);
                // Square-root encoding retains twilight precision in RGBA8.
                data[j + c] = Math.round(255 * Math.sqrt(Math.min(1, Math.max(0, radiance))));
            }
            data[j + 3] = 255;
        }
    }
    return { width, height, data };
}
module.exports = { generate };
