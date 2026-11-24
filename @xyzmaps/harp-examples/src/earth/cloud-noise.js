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
                    py = cy + hash(cy + 7, cz + 13, cx + 3, period) - y,
                    pz = cz + hash(cz + 11, cx + 5, cy + 17, period) - z;
                distance = Math.min(distance, px * px + py * py + pz * pz);
            }
    return 1 - Math.min(1, Math.sqrt(distance));
}
// Precompute the lattice values once per octave. Every voxel in the volume
// visits the same small set of cells, including their periodic border.
function lattice(period) {
    const edge = period + 4;
    const points = new Float64Array(edge ** 3 * 3), values = new Float64Array(edge ** 3);
    for (let z = -2; z < period + 2; z++) {
        for (let y = -2; y < period + 2; y++) {
            for (let x = -2; x < period + 2; x++) {
                const i = ((z + 2) * edge + y + 2) * edge + x + 2;
                values[i] = hash(x, y, z, period);
                points[i*3] = x + values[i];
                points[i*3+1] = y + hash(y+7,z+13,x+3,period);
                points[i*3+2] = z + hash(z+11,x+5,y+17,period);
            }
        }
    }
    const plane = edge * edge;
    function cubic(t) { return t*t*t*(t*(t*6-15)+10); }
    return {
        value(x,y,z) {
            const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z);
            const i=((iz+2)*edge + iy+2)*edge + ix+2;
            const fx=cubic(x-ix),fy=cubic(y-iy),fz=cubic(z-iz);
            return lerp(
                lerp(lerp(values[i],values[i+1],fx),lerp(values[i+edge],values[i+edge+1],fx),fy),
                lerp(lerp(values[i+plane],values[i+plane+1],fx),lerp(values[i+plane+edge],values[i+plane+edge+1],fx),fy),
                fz);
        },
        worley(x,y,z) {
            const first = ((Math.floor(z)+1)*edge+Math.floor(y)+1)*edge+Math.floor(x)+1;
            let distance=4;
            for (let dz=0;dz<3;dz++) for (let dy=0;dy<3;dy++) {
                let i=(first+dz*plane+dy*edge)*3;
                for(let dx=0;dx<3;dx++,i+=3){
                    const ax=points[i]-x,ay=points[i+1]-y,az=points[i+2]-z;
                    distance=Math.min(distance,ax*ax+ay*ay+az*az);
                }
            }
            return 1-Math.min(1,Math.sqrt(distance));
        }
    };
}
function generateVolume() {
    const volume = new Uint8Array(SIZE ** 3 * 4);
    const low=lattice(4),mid=lattice(8),high=lattice(16),small=lattice(12);
    let i=0;
    for(let z=0;z<SIZE;z++)for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++){
        const sx=x/SIZE,sy=y/SIZE,sz=z/SIZE;
        const v=low.value(sx*4,sy*4,sz*4)*.57+mid.value(sx*8,sy*8,sz*8)*.29+high.value(sx*16,sy*16,sz*16)*.14;
        const warp=.4*(v-.5);
        const w=low.worley(sx*4+warp,sy*4-warp,sz*4+warp);
        const fine=small.worley(sx*12,sy*12,sz*12);
        volume[i++]=Math.round(255*(v*.65+w*.35));
        volume[i++]=Math.round(255*w);
        volume[i++]=Math.round(255*fine);
        volume[i++]=Math.round(255*v);
    }
    return volume;
}
function generate() {
    const width = TILES * STRIDE, height = TILES * STRIDE;
    const data = new Uint8Array(width * height * 4);
    const volume = generateVolume();
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
module.exports = { SIZE, TILES, STRIDE, generateVolume, generate, hash, value, worley };
