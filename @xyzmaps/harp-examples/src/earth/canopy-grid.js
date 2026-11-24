// ETH's image service uses geographic degrees with its origin at 180 W, 84 N.
// Render patches use Web Mercator so they can borrow an exact satellite page.
const pixelsPerDegree = 12000;
const sourceSize = 256;
const latitudeAt = y => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
const mercatorY = lat => (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
function hash(x, y, salt) {
    let h = Math.imul(x ^ Math.imul(y, 1779033703) ^ salt, 1597334677);
    h = Math.imul(h ^ (h >>> 13), 3812015801);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function bounds({ x, y, z }) {
    const n = 2 ** z;
    return {
        left: Math.floor(((x * 360) / n) * pixelsPerDegree),
        right: Math.ceil((((x + 1) * 360) / n) * pixelsPerDegree),
        top: Math.max(0, Math.floor((84 - latitudeAt(y / n)) * pixelsPerDegree)),
        bottom: Math.min(
            144 * pixelsPerDegree,
            Math.ceil((84 - latitudeAt((y + 1) / n)) * pixelsPerDegree)
        )
    };
}
function sourceTiles(box) {
    const out = [];
    for (let y = Math.floor(box.top / sourceSize); y * sourceSize < box.bottom; y++)
        for (let x = Math.floor(box.left / sourceSize); x * sourceSize < box.right; x++)
            out.push({ x, y });
    return out;
}
function patchInstances(tile, box, rasters, limit, needleleaf) {
    const n = 2 ** tile.z,
        trees = [];
    for (let y = box.top; y < box.bottom; y++) {
        for (let x = box.left; x < box.right; x++) {
            const raster = rasters.get(Math.floor(x / 256) + "/" + Math.floor(y / 256));
            if (!raster) continue;
            const index = (y % 256) * 256 + (x % 256),
                height = raster.heights[index];
            if (height < 4 || height > 80 || (raster.mask && !raster.mask[index])) continue;
            const order = hash(x, y, 79),
                variety = hash(x, y, 317),
                seed = hash(x, y, 2377);
            if (order < 0.34) continue;
            const mx = (x + 0.15 + 0.7 * order) / (pixelsPerDegree * 360);
            const lat = 84 - (y + 0.15 + 0.7 * variety) / pixelsPerDegree;
            const u = mx * n - tile.x,
                v = 1 - (mercatorY(lat) * n - tile.y);
            if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
            const conifer = hash(x, y, 1753) < needleleaf;
            trees.push({
                u,
                v,
                height: height * (0.76 + 0.16 * variety),
                species: (variety > 0.57 ? 1 : 0) + (conifer ? 2 : 0),
                order,
                seed
            });
        }
    }
    if (trees.length > limit) trees.sort((a, b) => a.order - b.order);
    const count = Math.min(trees.length, limit),
        values = new Float32Array(count * 5);
    for (let i = 0; i < count; i++) {
        const t = trees[i],
            offset = i * 5;
        values[offset] = t.u;
        values[offset + 1] = t.v;
        values[offset + 2] = t.height;
        values[offset + 3] = t.species;
        values[offset + 4] = t.seed;
    }
    return values;
}
module.exports = { pixelsPerDegree, latitudeAt, mercatorY, bounds, sourceTiles, patchInstances };
