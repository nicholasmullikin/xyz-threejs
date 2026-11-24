const fs = require("node:fs"),
    path = require("node:path");
const source = path.resolve(__dirname, "../@xyzmaps/harp-examples/src/earth");
function build() {
    const { width, height, data } = require(path.join(source, "atmosphere-lut.js")).generate();
    const multiple = require("./multiple-scattering.cjs").generate({ width, height, data });
    fs.writeFileSync(
        path.join(source, "multiple-scattering.json"),
        JSON.stringify({
            width: multiple.width,
            height: multiple.height,
            rgba: Buffer.from(multiple.data).toString("base64")
        }) + "\n"
    );
    fs.writeFileSync(
        path.join(source, "atmosphere-lut.json"),
        JSON.stringify({ width, height, rgba: Buffer.from(data).toString("base64") }) + "\n"
    );
}
if (require.main === module) build();
module.exports = { build };
