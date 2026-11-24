// Once a provider reports a missing tile, move down its available pyramid.
// A miss at one zoom neither hides its neighbours nor permanently rules out
// finer source coverage after the provider publishes newer imagery.
function firstAvailable(tile, level, floor, missing, now, prefix = "") {
    for (let z = level; z >= floor; z--) {
        const scale = 2 ** (tile.z - z),
            x = Math.floor(tile.x / scale),
            y = Math.floor(tile.y / scale);
        const key = prefix + z + "/" + x + "/" + y;
        if ((missing.get(key)?.until || 0) <= now) return { z, x, y, key };
    }
}

// A damaged satellite page can fail to decode even when the browser and
// endpoint support WebP. Retry that page as JPEG; switch the whole source
// only on explicit format refusal or repeated independent decode failures.
function createFormatPolicy() {
    const alternate = new Map(),
        recent = [];
    let forceJpegUntil = 0;
    return {
        format(key, now) {
            return now < forceJpegUntil || (alternate.get(key) || 0) > now ? "jpg80" : "webp";
        },
        rejected(key, format, error, now) {
            if (format !== "webp" || key.startsWith("c:")) return false;
            if ([406, 415, 422].includes(error?.status)) {
                forceJpegUntil = Infinity;
                return true;
            }
            if (!/decod/i.test(error?.message || "")) return false;
            if (alternate.size >= 256) alternate.delete(alternate.keys().next().value);
            alternate.set(key, now + 900000);
            while (recent.length && now - recent[0].time > 10000) recent.shift();
            if (!recent.some(e => e.key === key)) recent.push({ key, time: now });
            if (recent.length >= 3) {
                forceJpegUntil = now + 1800000;
                recent.length = 0;
            }
            return true;
        }
    };
}

// Only apply this colour test to meshes independently confirmed by the DEM
// provider as open water. Grey ice sheets and fine coastal data keep refining.
function isUniformWater(rgba) {
    if (rgba[2] < rgba[0] + 4 || rgba[2] < rgba[1] || rgba[3] !== 255) return false;
    for (let i = 4; i < rgba.length; i += 4) {
        if (
            rgba[i + 3] !== 255 ||
            Math.abs(rgba[i] - rgba[0]) > 1 ||
            Math.abs(rgba[i + 1] - rgba[1]) > 1 ||
            Math.abs(rgba[i + 2] - rgba[2]) > 1
        )
            return false;
    }
    return true;
}

// A provisional 256px image occupies the same geographic tile as its 512px
// replacement. Keep both addressable through their cross-fade and cache pins.
function residentPage(cache, key) {
    return cache.get(key) || cache.get("s:" + key);
}
function sourceLevel(entry) {
    return entry.z - (entry.compact ? 1 : 0);
}
// The small thumbnail rejects most candidates. Verify every native RGBA
// texel before replacing a source image, including tiny islands and vessels.
function uniformColor(rgba) {
    if (!rgba.length || rgba.byteOffset % 4 || rgba.byteLength % 4) return;
    const words = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength / 4);
    const first = words[0];
    for (let i = 1; i < words.length; i++) if (words[i] !== first) return;
    return [...rgba.subarray(0, 4)];
}
function createUniformPages() {
    let thumbnail, full;
    const make = size => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        return canvas.getContext("2d", { willReadFrequently: true });
    };
    function compact(texture) {
        if (!texture.userData.encodedBytes || texture.userData.encodedBytes > 8000) return;
        thumbnail ||= make(16);
        if (!thumbnail) return;
        const image = texture.image;
        thumbnail.drawImage(image, 0, 0, 16, 16);
        if (!uniformColor(thumbnail.getImageData(0, 0, 16, 16).data)) return;
        full ||= make(image.width);
        if (!full) return;
        if (full.canvas.width !== image.width) full.canvas.width = image.width;
        if (full.canvas.height !== image.height) full.canvas.height = image.height;
        full.drawImage(image, 0, 0);
        const rgba = uniformColor(full.getImageData(0, 0, image.width, image.height).data);
        if (!rgba || rgba[3] !== 255) return;
        const pixel = document.createElement("canvas");
        pixel.width = pixel.height = 1;
        const ctx = pixel.getContext("2d");
        ctx.fillStyle = `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`;
        ctx.fillRect(0, 0, 1, 1);
        require("./textures").releaseBitmap(texture);
        texture.image = pixel;
        texture.flipY = true;
        texture.generateMipmaps = false;
        return rgba;
    }
    return {
        compact,
        dispose() {
            thumbnail = full = undefined;
        }
    };
}

module.exports = {
    firstAvailable,
    residentPage,
    sourceLevel,
    isUniformWater,
    uniformColor,
    createUniformPages,
    createFormatPolicy
};
