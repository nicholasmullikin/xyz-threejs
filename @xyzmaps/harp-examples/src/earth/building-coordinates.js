// Centering tile coordinates leaves room for buffered footprints crossing a tile edge.
// A z14 tile at the equator has a 7.5 cm step; standard MVT corners are exactly representable.
const SCALE = 32768;
function pack(values) {
    const result = new Int16Array(values.length);
    for (let i = 0; i < values.length; i++) {
        const encoded = Math.round((values[i] - 0.5) * SCALE);
        if (encoded < -32768 || encoded > 32767) {
            // Unusually wide footprints retain their original coordinates without clamping.
            return Float32Array.from(values, value => (value - 0.5) * SCALE);
        }
        result[i] = encoded;
    }
    return result;
}
function unpack(value) {
    return value / SCALE + 0.5;
}
module.exports = { SCALE, pack, unpack };
