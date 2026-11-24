// NOAA GFS 1-degree cloud cover uses GRIB2 template 5.3. Limit decoding to
// the documented global regular grid and instantaneous cloud fraction fields.
const width = 360, height = 181, samples = width * height;

function decodeCloudGrid(buffer) {
    const data = new DataView(buffer);
    const u8 = i => data.getUint8(i);
    const u16 = i => data.getUint16(i);
    const u32 = i => data.getUint32(i);
    const signed = (n, bits) => n >= 2 ** (bits - 1) ? 2 ** (bits - 1) - n : n;
    if (buffer.byteLength < 16 || buffer.byteLength > 300000 || u32(0) !== 0x47524942 ||
        u8(7) !== 2 || u32(8) !== 0 || u32(12) !== buffer.byteLength ||
        u32(buffer.byteLength - 4) !== 0x37373737) throw Error("Incomplete GFS field");
    const section = [];
    for (let pos = 16; pos < buffer.byteLength - 4;) {
        const length = u32(pos);
        if (length < 5 || pos + length > buffer.byteLength - 4) throw Error("Incomplete GFS section");
        section[u8(pos + 4)] = pos;
        pos += length;
    }
    const grid = section[3], product = section[4], packing = section[5], bitmap = section[6], payload = section[7];
    if (!grid || !product || !packing || !bitmap || !payload || u16(grid + 12) !== 0 ||
        u32(grid + 30) !== width || u32(grid + 34) !== height || u32(grid + 46) !== 90000000 ||
        u32(grid + 50) !== 0 || u32(grid + 63) !== 1000000 || u32(grid + 67) !== 1000000 ||
        u8(grid + 71) !== 0 || u8(bitmap + 5) !== 255 || u32(packing + 5) !== samples ||
        u16(product + 7) !== 0 || u8(product + 9) !== 6 || ![3,4,5].includes(u8(product + 10)))
        throw Error("Unexpected GFS cloud grid");
    const reference = data.getFloat32(packing + 11);
    const binary = 2 ** signed(u16(packing + 15), 16);
    const decimal = 10 ** -signed(u16(packing + 17), 16);
    const bits = u8(packing + 19), template = u16(packing + 9);
    const field = new Uint8Array(samples);
    let cursor = (payload + 5) * 8;
    const end = (payload + u32(payload)) * 8;
    function read(count) {
        if (count > 32 || cursor + count > end) throw Error("Incomplete GFS packing");
        let result = 0;
        while (count) {
            const available = 8 - cursor % 8, take = Math.min(count, available);
            result = result * 2 ** take + ((u8(Math.floor(cursor / 8)) >> (available - take)) & ((1 << take) - 1));
            cursor += take;
            count -= take;
        }
        return result;
    }
    function store(i, value) {
        const percent = (reference + binary * value) * decimal;
        if (!(percent >= -0.1 && percent <= 100.1)) throw Error("Invalid GFS cloud cover");
        field[i] = Math.round(percent * 2.55);
    }
    if (template === 0) {
        for (let i = 0; i < samples; i++) store(i, read(bits));
        return field;
    }
    if (template !== 3 || u8(packing + 21) !== 1 || u8(packing + 22) !== 0)
        throw Error("Unsupported GFS packing");
    const groups = u32(packing + 31), order = u8(packing + 47), extra = u8(packing + 48) * 8;
    if (!groups || groups > samples || (order !== 1 && order !== 2) || extra < 8 || extra > 32)
        throw Error("Invalid GFS group descriptors");
    let previous = read(extra), current = order === 2 ? read(extra) : previous;
    const minimum = signed(read(extra), extra);
    function descriptors(n) {
        const result = Uint32Array.from({length:groups}, () => read(n));
        cursor = Math.ceil(cursor / 8) * 8;
        return result;
    }
    const refs = descriptors(bits), widths = descriptors(u8(packing + 36)), lengths = descriptors(u8(packing + 46));
    let i = 0;
    for (let g = 0; g < groups; g++) {
        const count = g === groups - 1 ? u32(packing + 42) : u32(packing + 37) + lengths[g] * u8(packing + 41);
        const size = widths[g] + u8(packing + 35);
        if (i + count > samples) throw Error("Invalid GFS group lengths");
        for (let j = 0; j < count; j++, i++) {
            const delta = refs[g] + read(size) + minimum;
            if (i >= order) {
                const next = current + delta + (order === 2 ? current - previous : 0);
                previous = current;
                current = next;
            }
            store(i, i === 0 ? previous : current);
        }
    }
    if (i !== samples) throw Error("Incomplete GFS grid");
    return field;
}
module.exports = { decodeCloudGrid, width, height };
