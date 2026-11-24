// Each occupied z13 tile contains uint16 pairs in north-down Mercator space.
const { PMTiles, SharedPromiseCache } = require("pmtiles");
function mappedLamps() {
    const archive = new PMTiles(
        new URL("/earth-data/street-lamps.pmtiles", location.href).href,
        new SharedPromiseCache(12)
    );
    return async (x, y, signal) => {
        const record = await archive.getZxy(13, x, y, signal);
        if (!record) return new Uint16Array();
        if (record.data.byteLength % 4 || record.data.byteLength > 1048576)
            throw Error("Invalid street light record");
        return new Uint16Array(record.data);
    };
}
module.exports = { mappedLamps };
