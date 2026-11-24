const Lerc = require("lerc");
const { bounds, sourceTiles, patchInstances, latitudeAt } = require("./canopy-grid");
const source =
    "https://tiledimageservices.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/10m_Tree_Canopy_Height/ImageServer/tile/13/";
const cache = new Map();
let biome;
async function loadBiome() {
    const response = await fetch("resources/earth/forest-type.png");
    if (!response.ok) throw Error("Forest classification unavailable");
    const image = await createImageBitmap(await response.blob());
    try {
        const canvas = new OffscreenCanvas(image.width, image.height),
            ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        return {
            w: image.width,
            h: image.height,
            rgba: ctx.getImageData(0, 0, image.width, image.height).data
        };
    } finally {
        image.close();
    }
}
async function fetchRaster(x, y) {
    const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(source + y + "/" + x, { signal: controller.signal });
        if (response.status === 404 || response.status === 204) return null;
        if (!response.ok) throw Error("Canopy service unavailable");
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > 400000) throw Error("Unexpected canopy grid size");
        const r = Lerc.decode(buffer);
        if (
            r.width !== 256 ||
            r.height !== 256 ||
            r.pixels.length !== 1 ||
            !(r.pixels[0] instanceof Uint8Array)
        )
            throw Error("Unexpected canopy grid");
        return { heights: r.pixels[0], mask: r.mask };
    } finally {
        clearTimeout(timer);
    }
}
function raster(x, y) {
    const key = x + "/" + y;
    let result = cache.get(key);
    if (result) cache.delete(key);
    else
        result = fetchRaster(x, y).catch(e => {
            if (cache.get(key) === result) cache.delete(key);
            throw e;
        });
    cache.set(key, result);
    if (cache.size > 12) cache.delete(cache.keys().next().value);
    return result;
}
self.onmessage = async ({ data }) => {
    const { tile, limit, id } = data;
    try {
        const box = bounds(tile),
            sources = sourceTiles(box),
            grids = new Map();
        const classification = await (biome ??= loadBiome().catch(() => undefined));
        const n = 2 ** tile.z;
        const t = classification,
            lat = latitudeAt((tile.y + 0.5) / n);
        const fraction = t
            ? t.rgba[
                  4 *
                      (Math.min(t.h - 1, Math.floor(((90 - lat) / 180) * t.h)) * t.w +
                          Math.floor(((tile.x + 0.5) / n) * t.w))
              ] / 255
            : 0.18;
        await Promise.all(
            sources.map(async ({ x, y }) => {
                grids.set(x + "/" + y, await raster(x, y));
            })
        );
        const values = patchInstances(tile, box, grids, limit, fraction);
        self.postMessage({ id, values }, [values.buffer]);
    } catch {
        self.postMessage({ id, error: true });
    }
};
