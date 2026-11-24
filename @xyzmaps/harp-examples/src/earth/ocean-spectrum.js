// Periodic directional gravity-wave slopes. Generate two independent, band-limited
// height spectra and differentiate them in frequency space. Packing the X and Y
// slopes as real + imaginary lets one inverse FFT recover both derivatives.
const SIZE = 128;

function* makeSlopes(size = SIZE) {
    let seed = 0x9e3779b9;
    const random = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) / 4294967296 - 0.5;
    };
    const count = size * size;
    const real = new Float32Array(count),
        imag = new Float32Array(count);
    const cos = new Float64Array(size),
        sin = new Float64Array(size);
    const reverse = new Uint16Array(size);
    for (let i = 0; i < size; i++) {
        const phase = (2 * Math.PI * i) / size;
        cos[i] = Math.cos(phase);
        sin[i] = Math.sin(phase);
        reverse[i] = (reverse[i >> 1] >> 1) | ((i & 1) * (size >> 1));
    }
    function transform(start, stride) {
        for (let i = 0; i < size; i++) {
            if (i >= reverse[i]) continue;
            const a = start + i * stride,
                b = start + reverse[i] * stride;
            const x = real[a],
                y = imag[a];
            real[a] = real[b];
            imag[a] = imag[b];
            real[b] = x;
            imag[b] = y;
        }
        for (let half = 1; half < size; half *= 2) {
            const step = size / (2 * half);
            for (let j = 0; j < half; j++) {
                const c = cos[j * step],
                    s = sin[j * step];
                for (let i = j; i < size; i += 2 * half) {
                    const a = start + i * stride,
                        b = a + half * stride;
                    const x = real[b] * c - imag[b] * s,
                        y = real[b] * s + imag[b] * c;
                    real[b] = real[a] - x;
                    imag[b] = imag[a] - y;
                    real[a] += x;
                    imag[a] += y;
                }
            }
        }
    }

    const bytes = new Uint8Array(count * 4);
    for (let band = 0; band < 2; band++) {
        const wind = band ? 0.72 : 0.54,
            peak = band ? 4.6 : 3.3,
            cutoff = band ? 23 : 18;
        const dx = Math.cos(wind),
            dy = Math.sin(wind);
        real.fill(0);
        imag.fill(0);
        for (let y = 0; y < size; y++) {
            const ky = y > size / 2 ? y - size : y;
            for (let x = 0; x < size; x++) {
                const kx = x > size / 2 ? x - size : x,
                    i = y * size + x;
                const mirror = ((size - y) % size) * size + ((size - x) % size);
                if (i >= mirror || x === size / 2 || y === size / 2) continue;
                const k2 = kx * kx + ky * ky,
                    along = (kx * dx + ky * dy) ** 2 / k2;
                const amplitude =
                    (Math.sqrt(0.03 + along * along) *
                        Math.exp(-0.5 * ((peak * peak) / k2 + k2 / (cutoff * cutoff)))) /
                    k2;
                const a = random() * amplitude,
                    b = random() * amplitude;
                real[i] = -kx * b - ky * a;
                imag[i] = kx * a - ky * b;
                real[mirror] = -kx * b + ky * a;
                imag[mirror] = -kx * a - ky * b;
            }
            if (y % 8 === 7) yield;
        }
        for (let i = 0; i < size; i++) {
            transform(i * size, 1);
            if (i % 8 === 7) yield;
        }
        for (let i = 0; i < size; i++) {
            transform(i, size);
            if (i % 8 === 7) yield;
        }
        let energy = 0;
        for (let i = 0; i < count; i++) energy += real[i] ** 2 + imag[i] ** 2;
        const scale = 127.5 / (3.6 * Math.sqrt(energy / (2 * count)));
        for (let i = 0; i < count; i++) {
            bytes[4 * i + band * 2] = Math.max(
                0,
                Math.min(255, Math.round(127.5 + scale * real[i]))
            );
            bytes[4 * i + band * 2 + 1] = Math.max(
                0,
                Math.min(255, Math.round(127.5 + scale * imag[i]))
            );
        }
        yield;
    }
    return bytes;
}
module.exports = { SIZE, makeSlopes };
