// Preserve harp's transferable ArrayBuffer contract for tile decoders. Untagged
// tiles retain the original MVT bytes, including the zero-length empty tile.
function attachRoofTags(tile, tags) {
    if (!tags || !tile.byteLength) return tile;
    const out = new Uint8Array(8 + tile.byteLength + tags.byteLength);
    out.set([69, 82, 66, 49]); // ERB1 envelope
    new DataView(out.buffer).setUint32(4, tile.byteLength, true);
    out.set(new Uint8Array(tile), 8);
    out.set(new Uint8Array(tags), 8 + tile.byteLength);
    return out.buffer;
}
function splitRoofTags(input) {
    const bytes = new Uint8Array(input);
    if (
        bytes.length < 12 ||
        bytes[0] !== 69 ||
        bytes[1] !== 82 ||
        bytes[2] !== 66 ||
        bytes[3] !== 49
    )
        return { tile: input };
    const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
    if (size > bytes.length - 12) throw Error("Invalid roof envelope");
    const tile = bytes.subarray(8, 8 + size);
    let pos = 8 + size;
    if (bytes[pos++] !== 69 || bytes[pos++] !== 82 || bytes[pos++] !== 70 || bytes[pos++] !== 52)
        return { tile };
    function varint() {
        let value = 0,
            shift = 1;
        for (let i = 0; i < 7 && pos < bytes.length; i++) {
            const n = bytes[pos++];
            value += (n & 127) * shift;
            if (n < 128) return value;
            shift *= 128;
        }
        throw Error("Invalid roof tag");
    }
    const bins = new Map(),
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bucket = (x, y) => Math.floor(x / 32) + 8192 * Math.floor(y / 32);
    try {
        let id = 0;
        while (pos < bytes.length) {
            id += varint();
            if (pos >= bytes.length) return { tile };
            const flags = bytes[pos++],
                rise = flags & 64 ? varint() / 10 : 0;
            const bearing = flags & 128 ? (bytes[pos++] * 360) / 256 : undefined;
            const style = bytes[pos++];
            function readColor() {
                const c = view.getUint16(pos, true);
                pos += 2;
                return [
                    Math.round(((c >> 11) * 255) / 31),
                    Math.round((((c >> 5) & 63) * 255) / 63),
                    Math.round(((c & 31) * 255) / 31)
                ];
            }
            const color = style & 1 ? readColor() : undefined;
            const wallColor = style & 8 ? readColor() : undefined,
                wallClass = style & 16 ? bytes[pos++] : 0;
            if (pos > bytes.length - 8) return { tile };
            const bounds = [0, 2, 4, 6].map(offset => view.getInt16(pos + offset, true));
            pos += 8;
            const [l, t, r, b] = bounds,
                key = bucket((l + r) * 0.5, (t + b) * 0.5);
            let bin = bins.get(key);
            if (!bin) bins.set(key, (bin = []));
            bin.push({
                id,
                bounds,
                color,
                wallColor,
                wallClass,
                plain: !!(style & 2),
                part: !!(style & 4),
                shape: flags & 15,
                across: !!(flags & 16),
                measured: !!(flags & 32),
                rise,
                bearing
            });
        }
    } catch {
        return { tile };
    }
    // OpenMapTiles may merge hundreds of unrelated same-height footprints into
    // one MVT feature. Validate each polygon independently in the z12 tag grid.
    const tags = {
        match(id, x, y, extent, minX, minY, maxX, maxY) {
            const scale = 4096 / extent,
                left = (x % 4) * 4096,
                top = (y % 4) * 4096;
            const bounds = [
                left + minX * scale,
                top + minY * scale,
                left + maxX * scale,
                top + maxY * scale
            ];
            const [l, t, r, b] = bounds,
                cx = (l + r) * 0.5,
                cy = (t + b) * 0.5;
            const tolerance = Math.min(3, Math.max(1.1, 0.07 * Math.min(r - l, b - t)));
            let best,
                score = Infinity,
                ambiguous = false;
            for (let j = -1; j <= 1; j++)
                for (let i = -1; i <= 1; i++) {
                    const candidates = bins.get(bucket(cx + 32 * i, cy + 32 * j));
                    if (!candidates) continue;
                    for (const tag of candidates) {
                        let distance = 0,
                            maximum = 0;
                        for (let k = 0; k < 4; k++) {
                            const d = Math.abs(tag.bounds[k] - bounds[k]);
                            distance += d;
                            maximum = Math.max(maximum, d);
                        }
                        if (maximum > tolerance) continue;
                        if (tag.id === id) return tag;
                        if (distance < score - 0.4) {
                            best = tag;
                            score = distance;
                            ambiguous = false;
                        } else if (
                            distance <= score + 0.4 &&
                            best &&
                            (best.shape !== tag.shape ||
                                best.rise !== tag.rise ||
                                best.across !== tag.across ||
                                best.bearing !== tag.bearing ||
                                best.plain !== tag.plain ||
                                best.measured !== tag.measured ||
                                best.wallClass !== tag.wallClass ||
                                String(best.wallColor) !== String(tag.wallColor) ||
                                String(best.color) !== String(tag.color))
                        )
                            ambiguous = true;
                    }
                }
            return ambiguous ? undefined : best;
        }
    };
    return { tile, tags };
}
module.exports = { attachRoofTags, splitRoofTags };
