// The published 2021 Sentinel-2 annual true-colour composite. The service
// supports Web Mercator only at zoom 8–14 and latitude 60°S–83°N.
const layer = "esa-worldcover-s2rgbnir-10m-2021-v2_tcc";
function worldCoverTile(z, x, y) {
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 8 || z > 14) return;
    const n = 2 ** z;
    if (x < 0 || x >= n || y < 0 || y >= n) return;
    const minRow = Math.floor(((1 - Math.asinh(Math.tan((83 * Math.PI) / 180)) / Math.PI) / 2) * n);
    const maxRow = Math.floor(
        ((1 - Math.asinh(Math.tan((-60 * Math.PI) / 180)) / Math.PI) / 2) * n
    );
    if (y < minRow || y > maxRow) return;
    const params = new URLSearchParams({
        SERVICE: "WMTS",
        REQUEST: "GetTile",
        VERSION: "1.0.0",
        LAYER: layer,
        STYLE: "default",
        TILEMATRIXSET: "EPSG:3857",
        TILEMATRIX: String(z),
        TILECOL: String(x),
        TILEROW: String(y),
        FORMAT: "image/png",
        TIME: "2021-01-01"
    });
    return `https://wmts.terrascope.be/wmts?${params}`;
}

// SWISSIMAGE product PNG carries swisstopo's own coverage alpha, including
// coverage beyond the national border. The bbox only rejects impossible tiles.
function swissImageTile(z, x, y) {
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 8 || z > 20) return;
    const n = 2 ** z;
    if (x < 0 || x >= n || y < 0 || y >= n) return;
    const column = lon => Math.floor(((lon + 180) / 360) * n);
    const row = lat =>
        Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
    if (x < column(5.140242) || x > column(11.47757) || y < row(48.230651) || y > row(45.398181))
        return;
    return `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage-product/default/current/3857/${z}/${x}/${y}.png`;
}
// Both regional services accept Web Mercator bounding boxes (metres).
function regionalTile(bounds, maxZoom, url) {
    return (z, x, y) => {
        const n = 2 ** z;
        if (![z, x, y].every(Number.isInteger) || z < 8 || z > maxZoom ||
            x < 0 || y < 0 || x >= n || y >= n) return;
        const edge = Math.PI * 6378137, size = 2 * edge / n;
        const west = x * size - edge, north = edge - y * size;
        const east = west + size, south = north - size;
        if (east <= bounds[0] || north <= bounds[1] || west >= bounds[2] || south >= bounds[3]) return;
        return url([west, south, east, north].join(","), z, x, y);
    };
}

const berlin = regionalTile([1452450, 6857544, 1532582, 6925018], 19, bbox =>
    "https://gdi.berlin.de/services/wms/truedop_2025_sommer?" + new URLSearchParams({
        SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetMap", CRS: "EPSG:3857",
        LAYERS: "truedop_2025_sommer_rgb", STYLES: "", FORMAT: "image/png",
        TRANSPARENT: "TRUE", WIDTH: "256", HEIGHT: "256", BBOX: bbox
    })
);
const mosaicApi = "https://planetarycomputer.microsoft.com/api/data/v1/mosaic";
function catalogMosaic(collection, search, assets, maxZoom, bounds) {
    let id;
    async function prepare() {
        // Catalog search IDs expire. Obtain a current ID only for the selected layer.
        const response = await fetch(mosaicApi + "/register", {
            method: "POST", headers: {"Content-Type": "application/json"},
            body: JSON.stringify({collections: [collection], ...search}),
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw Error("Imagery catalog unavailable");
        const result = await response.json();
        if (!result.id) throw Error("Imagery catalog returned no mosaic");
        id = encodeURIComponent(result.id);
    }
    const query = new URLSearchParams({collection, ...assets});
    const tile = regionalTile(bounds, maxZoom, (_, z, x, y) => id &&
        mosaicApi + "/" + id + "/tiles/WebMercatorQuad/" + [z,x,y].join("/") + ".png?" + query);
    return { prepare, tile, tileSize: 256, minZoom: 8, maxZoom };
}

const himalayas = [28.0946629, 86.6531457, 7693.207, 40729.925, 39.84384, -12.6717];
function sentinelSeason(label, datetime) {
    return {
        name: "Sentinel-2 L2A · " + label + " 2023", example: himalayas, place: "Himalayas",
        credit: "Contains modified Copernicus Sentinel data (2023) · Microsoft Planetary Computer",
        creditUrl: "https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a",
        ...catalogMosaic("sentinel-2-l2a", {datetime, query: {"eo:cloud_cover": {lt: 20}},
            sortby: [{field: "properties.eo:cloud_cover", direction: "asc"}]},
            {assets: "visual"}, 14, [-20037509, -15538712, 20037509, 18807215])
    };
}
const sources = Object.assign(Object.create(null), {
    worldcover: {name: "ESA WorldCover · 2021", example: himalayas, place: "Himalayas",
        tileSize: 256, minZoom: 8, maxZoom: 14, tile: worldCoverTile},
    sentinel2: sentinelSeason("Sep–Nov", "2023-09-01/2023-11-30"),
    "sentinel2-spring": sentinelSeason("Mar–May", "2023-03-01/2023-05-31"),
    berlin: {name: "Berlin TrueDOP · summer 2025", example: [52.5163, 13.3777, 35, 1500, 30, 5], place: "Berlin",
        credit: "Geoportal Berlin · TrueDOP Sommer 2025 (DL-DE Zero 2.0)",
        creditUrl: "https://gdi.berlin.de/services/wms/truedop_2025_sommer?service=WMS&request=GetCapabilities",
        tileSize: 256, minZoom: 8, maxZoom: 19, tile: berlin},
    swissimage: {name: "SWISSIMAGE · Switzerland", example: [47.3769,8.5417,415,1600,35,0], place: "Zürich",
        tileSize: 256, minZoom: 8, maxZoom: 20, tile: swissImageTile},
    naip: {name: "USDA NAIP · contiguous US", example: [34.4050363,-119.8439841,4.805,449.355,79.2,-39.88], place: "Campus Point",
        credit: "USDA NAIP · Microsoft Planetary Computer",
        creditUrl: "https://planetarycomputer.microsoft.com/dataset/naip",
        ...catalogMosaic("naip", {sortby: [{field: "properties.datetime", direction: "desc"}]},
            {assets: "image", asset_bidx: "image|1,2,3"}, 18, [-13896163, 2812730, -7441890, 6372360])}
});
module.exports = { worldCoverTile, swissImageTile, sources };
