// Derive bounded, camera-local night textures from the public NASA composite.
// Keep the original angular resolution inside every overlapping night window.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const atlasRequire = createRequire(require.resolve("../@xyzmaps/harp-atlas-tools/package.json"));
const sharp = atlasRequire("sharp");

async function build(source, destination) {
    const night = path.join(source, "night-lights.jpg");
    const output = path.join(destination, "night");
    await fs.mkdir(output, { recursive: true });
    const { data, info } = await sharp(night)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
    if (info.width !== 8192 || info.height !== 4096 || info.channels !== 1)
        throw Error("Unexpected NASA night-light raster dimensions");
    await sharp(night)
        .resize(2048, 1024)
        .webp({ quality: 87 })
        .toFile(path.join(output, "global.webp"));
    const clouds = sharp(path.join(source, "clouds.jpg")).extractChannel(0);
    await Promise.all([
        clouds.clone().webp({ quality: 70, effort: 6 })
            .toFile(path.join(destination, "cloud-coverage.webp")),
        clouds.clone().resize(1024, 512).webp({ quality: 80, effort: 6 })
            .toFile(path.join(destination, "cloud-coverage-orbit.webp"))
    ]);
    // Noise channels are independent data, not a photograph: lossless encoding
    // preserves the periodic atlas and avoids introducing cloud-shape artifacts.
    await sharp(path.join(source, "cloud-noise.png"))
        .webp({ lossless: true, effort: 6 })
        .toFile(path.join(destination, "cloud-noise.webp"));
    const size = 1024;
    for (let row = 1; row < 8; row++) {
        for (let col = 0; col < 16; col++) {
            const page = Buffer.allocUnsafe(size * size);
            const x = (col * 512 - 512 + info.width) % info.width;
            const y = row * 512 - 512;
            const first = Math.min(size, info.width - x);
            for (let i = 0; i < size; i++) {
                const start = (y + i) * info.width;
                data.copy(page, i * size, start + x, start + x + first);
                if (first < size) data.copy(page, i * size + first, start, start + size - first);
            }
            await sharp(page, { raw: { width: size, height: size, channels: 1 } })
                .webp({ quality: 90 })
                .toFile(path.join(output, `${col}-${row}.webp`));
        }
    }
}
module.exports = { build };
if (require.main === module)
    build(process.argv[2], process.argv[3]).catch(e => {
        console.error(e);
        process.exitCode = 1;
    });
