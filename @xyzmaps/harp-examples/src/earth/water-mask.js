// Scan-convert the water polygons already present in each OpenMapTiles city
// tile. Even-odd parity preserves islands and holes; bits keep transfers small.
const SIDE = 256;
function waterMask(layer, transportation) {
    if (!layer?.length) return;
    const mask = new Uint8Array((SIDE * SIDE) / 8);
    if (!paintPolygons(mask, layer, true)) return;
    if (transportation?.length) paintPolygons(mask, transportation, false);
    return mask;
}

function paintPolygons(mask, layer, wet) {
    const scale = SIDE / layer.extent;
    let marked = false;
    for (let f = 0; f < layer.length; f++) {
        const feature = layer.feature(f);
        if (
            feature.type !== 3 ||
            (!wet && feature.properties.class !== "pier") ||
            feature.properties.intermittent === 1 ||
            feature.properties.brunnel === "tunnel"
        )
            continue;
        const rows = [];
        for (const ring of feature.loadGeometry()) {
            for (let j = 0, k = ring.length - 1; j < ring.length; k = j++) {
                const a = ring[k],
                    b = ring[j];
                if (a.y === b.y) continue;
                const y0 = Math.max(0, Math.ceil(Math.min(a.y, b.y) * scale - 0.5)),
                    y1 = Math.min(SIDE, Math.ceil(Math.max(a.y, b.y) * scale - 0.5));
                const dx = (b.x - a.x) / (b.y - a.y);
                for (let y = y0; y < y1; y++)
                    (rows[y] ??= []).push(a.x * scale + (y + 0.5 - a.y * scale) * dx);
            }
        }
        for (let y = 0; y < rows.length; y++) {
            const spans = rows[y];
            if (!spans) continue;
            spans.sort((a, b) => a - b);
            for (let j = 0; j + 1 < spans.length; j += 2) {
                let x = Math.max(0, Math.ceil(spans[j] - 0.5)),
                    end = Math.min(SIDE, Math.ceil(spans[j + 1] - 0.5));
                if (x >= end) continue;
                marked = true;
                const row = y * (SIDE / 8);
                for (; x < end && x & 7; x++) paintBit(mask, row, x, wet);
                const full = end >> 3;
                if (x >> 3 < full) {
                    mask.fill(wet ? 255 : 0, row + (x >> 3), row + full);
                    x = full * 8;
                }
                for (; x < end; x++) paintBit(mask, row, x, wet);
            }
        }
    }
    return marked;
}

function paintBit(mask, row, x, wet) {
    const index = row + (x >> 3), bit = 1 << (x & 7);
    if (wet) mask[index] |= bit;
    else mask[index] &= ~bit;
}
module.exports = { waterMask, SIDE };
