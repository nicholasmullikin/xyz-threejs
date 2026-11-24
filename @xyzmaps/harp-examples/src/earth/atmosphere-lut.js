/* Build-time Earth transmittance integration. Kept out of the browser bundle. */
const R = 6378.137,
    TOP = R + 100;
function generate() {
    const width = 256,
        height = 64,
        data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const altitude = (y / (height - 1)) ** 2 * 100 + 0.001,
                r = R + altitude,
                mu = (x / (width - 1)) * 2 - 1;
            const groundDisc = r * r * (mu * mu - 1) + R * R;
            let trans = [0, 0, 0];
            if (!(mu < 0 && groundDisc > 0)) {
                const distance = -r * mu + Math.sqrt(r * r * (mu * mu - 1) + TOP * TOP);
                let odR = 0,
                    odM = 0,
                    odO = 0;
                const steps = 48,
                    step = distance / steps;
                for (let i = 0; i < steps; i++) {
                    const t = (i + 0.5) * step,
                        h = Math.max(0, Math.sqrt(r * r + t * t + 2 * r * mu * t) - R);
                    odR += Math.exp(-h / 8) * step;
                    odM += Math.exp(-h / 1.2) * step;
                    odO += Math.max(0, 1 - Math.abs(h - 25) / 15) * step;
                }
                trans = [0.005802, 0.013558, 0.0331].map((beta, i) =>
                    Math.exp(-beta * odR - 0.00444 * odM - [0.00065, 0.001881, 0.000085][i] * odO)
                );
            }
            const j = (y * width + x) * 4;
            data[j] = Math.round(trans[0] * 255);
            data[j + 1] = Math.round(trans[1] * 255);
            data[j + 2] = Math.round(trans[2] * 255);
            data[j + 3] = 255;
        }
    return { width, height, data };
}
module.exports = { generate };
