/* Deterministic, periodic Perlin-style value/Worley volume, packed into a WebGL 1
 * 2D atlas. Generated at build time; no CPU noise work on the animation thread.
 * Each slice has a wrapping one-texel gutter for seam-free trilinear filtering.
 */
const SIZE = 64,
    TILES = 8,
    STRIDE = SIZE + 2;
function hash(x, y, z, period) {
    const wrap = n => ((n % period) + period) % period;
    let h =
        Math.imul(wrap(x), 374761393) ^
        Math.imul(wrap(y), 668265263) ^
        Math.imul(wrap(z), 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const lerp = (a, b, t) => a + (b - a) * t;
function value(x, y, z, period) {
    const ix = Math.floor(x),
        iy = Math.floor(y),
        iz = Math.floor(z);
    const smooth = n => n * n * n * (n * (n * 6 - 15) + 10);
    const fx = smooth(x - ix),
        fy = smooth(y - iy),
        fz = smooth(z - iz);
    return lerp(
        lerp(
            lerp(hash(ix, iy, iz, period), hash(ix + 1, iy, iz, period), fx),
            lerp(hash(ix, iy + 1, iz, period), hash(ix + 1, iy + 1, iz, period), fx),
            fy
        ),
        lerp(
            lerp(hash(ix, iy, iz + 1, period), hash(ix + 1, iy, iz + 1, period), fx),
            lerp(hash(ix, iy + 1, iz + 1, period), hash(ix + 1, iy + 1, iz + 1, period), fx),
            fy
        ),
        fz
    );
}
function worley(x, y, z, period) {
    const ix = Math.floor(x),
        iy = Math.floor(y),
        iz = Math.floor(z);
    let distance = 4;
    for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
                const cx = ix + dx,
                    cy = iy + dy,
                    cz = iz + dz;
                const px = cx + hash(cx, cy, cz, period) - x,
                    py = cy + hash(cy, cz, cx, period) - y,
                    pz = cz + hash(cz, cx, cy, period) - z;
                distance = Math.min(distance, px * px + py * py + pz * pz);
            }
    return 1 - Math.min(1, Math.sqrt(distance));
}
function generate() {
    const width = TILES * STRIDE,
        height = TILES * STRIDE,
        data = new Uint8Array(width * height * 4);
    const volume = new Uint8Array(SIZE * SIZE * SIZE * 4);
    for (let z = 0; z < SIZE; z++)
        for (let y = 0; y < SIZE; y++)
            for (let x = 0; x < SIZE; x++) {
                const a = [x / SIZE, y / SIZE, z / SIZE];
                const v =
                    value(a[0] * 4, a[1] * 4, a[2] * 4, 4) * 0.57 +
                    value(a[0] * 8, a[1] * 8, a[2] * 8, 8) * 0.29 +
                    value(a[0] * 16, a[1] * 16, a[2] * 16, 16) * 0.14;
                const w = worley(a[0] * 4, a[1] * 4, a[2] * 4, 4),
                    fine = worley(a[0] * 12, a[1] * 12, a[2] * 12, 12);
                const i = ((z * SIZE + y) * SIZE + x) * 4;
                volume[i] = Math.round(255 * (v * 0.65 + w * 0.35));
                volume[i + 1] = Math.round(255 * w);
                volume[i + 2] = Math.round(255 * fine);
                volume[i + 3] = Math.round(255 * v);
            }
    for (let z = 0; z < SIZE; z++)
        for (let y = -1; y <= SIZE; y++)
            for (let x = -1; x <= SIZE; x++) {
                const src = ((z * SIZE + ((y + SIZE) % SIZE)) * SIZE + ((x + SIZE) % SIZE)) * 4;
                const dst =
                    ((Math.floor(z / TILES) * STRIDE + y + 1) * width +
                        (z % TILES) * STRIDE +
                        x +
                        1) *
                    4;
                data.set(volume.subarray(src, src + 4), dst);
            }
    return { width, height, data };
}
module.exports = { SIZE, TILES, STRIDE, generate, hash, value, worley };
