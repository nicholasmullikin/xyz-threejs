// Canvas2D fade mosaics need geographic north-up pixels. Compressed mip rows
// use the GPU's bottom-up convention, just like the flipped ImageBitmap path.
const weights = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const modifiers = [
    [2, 8, -2, -8],
    [5, 17, -5, -17],
    [9, 29, -9, -29],
    [13, 42, -13, -42],
    [18, 60, -18, -60],
    [24, 80, -24, -80],
    [33, 106, -33, -106],
    [47, 183, -47, -183]
];
function decodeBC7(mip, pixels, left = 0, top = 0, width = mip.width, height = mip.height) {
    const data = new Uint32Array(mip.data.buffer, mip.data.byteOffset, mip.data.byteLength / 4);
    const north = mip.height - top,
        right = left + width,
        stride = Math.ceil(mip.width / 4);
    for (let y = north - height; y < north; y += 4)
        for (let x = left; x < right; x += 4) {
            let block = 4 * ((y >> 2) * stride + (x >> 2));
            const a = data[block++],
                b = data[block++],
                c = data[block++],
                d = data[block++];
            // The encoder writes BC7 mode 6 with opaque alpha and both P bits set.
            const r0 = ((a >>> 7) & 127) * 2 + 1,
                r1 = ((a >>> 14) & 127) * 2 + 1;
            const g0 = ((a >>> 21) & 127) * 2 + 1,
                g1 = ((a >>> 28) | ((b & 7) << 4)) * 2 + 1;
            const b0 = ((b >>> 3) & 127) * 2 + 1,
                b1 = ((b >>> 10) & 127) * 2 + 1;
            for (let j = 0; j < Math.min(4, north - y); j++)
                for (let i = 0; i < Math.min(4, right - x); i++) {
                    const p = j * 4 + i,
                        index = p === 0 ? (c >>> 1) & 7 : ((p < 8 ? c : d) >>> ((p % 8) * 4)) & 15;
                    const f = weights[index],
                        q = 64 - f,
                        k = ((north - y - j - 1) * width + x - left + i) * 4;
                    pixels[k] = (q * r0 + f * r1 + 32) >> 6;
                    pixels[k + 1] = (q * g0 + f * g1 + 32) >> 6;
                    pixels[k + 2] = (q * b0 + f * b1 + 32) >> 6;
                    pixels[k + 3] = 255;
                }
        }
}
const expand5 = value => (value << 3) | (value >> 2);
const expand6 = value => (value << 2) | (value >> 4);
const expand7 = value => (value << 1) | (value >> 6);
const delta3 = byte => (byte & 3) - (byte & 4 ? 4 : 0);
function decodeETC2(mip, pixels, left = 0, top = 0, width = mip.width, height = mip.height) {
    const { data } = mip;
    const north = mip.height - top,
        right = left + width,
        stride = Math.ceil(mip.width / 4);
    const base = new Int16Array(6),
        origin = new Int16Array(3),
        horizontal = new Int16Array(3),
        vertical = new Int16Array(3);
    for (let y = north - height; y < north; y += 4)
        for (let x = left; x < right; x += 4) {
            const offset = 8 * ((y >> 2) * stride + (x >> 2));
            const r = data[offset],
                g = data[offset + 1],
                b = data[offset + 2],
                flags = data[offset + 3];
            const difference = !!(flags & 2),
                blue = (b >> 3) + delta3(b);
            // The worker writes individual, differential and planar blocks. In
            // planar mode the 5-bit blue differential deliberately overflows.
            const planar = difference && (blue < 0 || blue > 31);
            if (planar) {
                const gh = data[offset + 4],
                    bh = data[offset + 5],
                    rv = data[offset + 6],
                    gv = data[offset + 7];
                origin[0] = expand6((r & 126) >> 1);
                origin[1] = expand7(((r & 1) << 6) | ((g & 126) >> 1));
                origin[2] = expand6(((g & 1) << 5) | (b & 24) | ((b & 3) << 1) | (flags >> 7));
                horizontal[0] = expand6(((flags & 124) >> 1) | (flags & 1));
                horizontal[1] = expand7(gh >> 1);
                horizontal[2] = expand6(((gh & 1) << 5) | (bh >> 3));
                vertical[0] = expand6(((bh & 7) << 3) | (rv >> 5));
                vertical[1] = expand7(((rv & 31) << 2) | (gv >> 6));
                vertical[2] = expand6(gv & 63);
            } else
                for (let c = 0; c < 3; c++) {
                    const value = data[offset + c];
                    base[c] = difference ? expand5(value >> 3) : (value >> 4) * 17;
                    base[c + 3] = difference
                        ? expand5((value >> 3) + delta3(value))
                        : (value & 15) * 17;
                }
            const high = data[offset + 4] * 256 + data[offset + 5],
                low = data[offset + 6] * 256 + data[offset + 7];
            for (let j = 0; j < Math.min(4, north - y); j++)
                for (let i = 0; i < Math.min(4, right - x); i++) {
                    const output = ((north - y - j - 1) * width + x - left + i) * 4;
                    if (planar) {
                        for (let c = 0; c < 3; c++)
                            pixels[output + c] =
                                (4 * origin[c] +
                                    i * (horizontal[c] - origin[c]) +
                                    j * (vertical[c] - origin[c]) +
                                    2) >>
                                2;
                    } else {
                        const part = (flags & 1 ? j : i) >> 1,
                            bit = 4 * i + j;
                        const selector = (((high >> bit) & 1) << 1) | ((low >> bit) & 1);
                        const shift = modifiers[part ? (flags >> 2) & 7 : flags >> 5][selector];
                        for (let c = 0; c < 3; c++) pixels[output + c] = base[3 * part + c] + shift;
                    }
                    pixels[output + 3] = 255;
                }
        }
}
let scratch, lastId, lastLevel, lastLeft, lastTop;
function drawCompressed(ctx, texture, sx, sy, sw, sh, dx, dy, dw, dh) {
    // Fade mosaics scale the parent canvas and again for each child. The
    // drawImage destination is in user-space units, not physical pixels.
    const transform = ctx.getTransform();
    const targetWidth = Math.max(1, Math.abs(dw) * Math.hypot(transform.a, transform.b));
    const targetHeight = Math.max(1, Math.abs(dh) * Math.hypot(transform.c, transform.d));
    const level = Math.min(
        texture.mipmaps.length - 1,
        Math.max(0, Math.floor(Math.log2(Math.min(sw / targetWidth, sh / targetHeight))))
    );
    const mip = texture.mipmaps[level],
        scale = 2 ** -level;
    const px = sx * scale,
        py = sy * scale,
        pw = sw * scale,
        ph = sh * scale;
    // A geographically coarse ancestor often contributes only a few dozen
    // pixels from its 512px image. Decode the intersecting compressed blocks,
    // keeping one texel outside the crop for the Canvas2D interpolation.
    const left = Math.max(0, Math.floor((px - 1) / 4) * 4);
    const top = Math.max(0, Math.floor((py - 1) / 4) * 4);
    const right = Math.min(mip.width, Math.ceil((px + pw + 1) / 4) * 4);
    const bottom = Math.min(mip.height, Math.ceil((py + ph + 1) / 4) * 4);
    const width = right - left,
        height = bottom - top;
    if (width <= 0 || height <= 0) return;
    if (
        lastId !== texture.id ||
        lastLevel !== level ||
        left < lastLeft ||
        top < lastTop ||
        right > lastLeft + scratch.width ||
        bottom > lastTop + scratch.height
    ) {
        scratch ??= document.createElement("canvas");
        if (scratch.width !== width) scratch.width = width;
        if (scratch.height !== height) scratch.height = height;
        const context = scratch.getContext("2d"),
            image = context.createImageData(width, height);
        const decode = texture.userData.pageCodec === "etc2" ? decodeETC2 : decodeBC7;
        decode(mip, image.data, left, top, width, height);
        context.putImageData(image, 0, 0);
        lastId = texture.id;
        lastLevel = level;
        lastLeft = left;
        lastTop = top;
    }
    ctx.drawImage(scratch, px - lastLeft, py - lastTop, pw, ph, dx, dy, dw, dh);
}
module.exports = { drawCompressed, decodeETC2, decodeBC7 };
