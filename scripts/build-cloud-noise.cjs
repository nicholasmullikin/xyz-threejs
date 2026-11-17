// Small RGBA PNG encoder using only Node built-ins; deterministic offline asset.
const fs = require("node:fs"),
    path = require("node:path"),
    zlib = require("node:zlib");
const model = require("../@xyzmaps/harp-examples/src/earth/cloud-noise");
function crc(data) {
    let c = 0xffffffff;
    for (const b of data) {
        c ^= b;
        for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const t = Buffer.from(type),
        size = Buffer.alloc(4),
        sum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([size, t, data, sum]);
}
function build(destination) {
    const { width, height, data } = model.generate(),
        head = Buffer.alloc(13);
    head.writeUInt32BE(width, 0);
    head.writeUInt32BE(height, 4);
    head[8] = 8;
    head[9] = 6;
    const rows = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++)
        rows.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    const png = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", head),
        chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
        chunk("IEND", Buffer.alloc(0))
    ]);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, png);
    return png.length;
}
module.exports = { build };
if (require.main === module)
    console.log(
        "Cloud noise atlas bytes:",
        build(
            process.argv[2] ||
                path.resolve(
                    __dirname,
                    "../@xyzmaps/harp-examples/src/earth/resources/cloud-noise.png"
                )
        )
    );
