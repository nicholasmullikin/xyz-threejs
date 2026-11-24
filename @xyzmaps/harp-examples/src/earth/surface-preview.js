// Synchronous NASA Blue Marble for the first frame and offline fallback.
// Rebuild the bundled palette and indices with scripts/build-earth-placeholder.py.
const { rows, palette } = require("./surface-preview.json");
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function createSurfacePreview(THREE) {
    const colors = new Uint8Array(alphabet.length * 4);
    const lookup = new Uint8Array(128);
    for (let i = 0; i < alphabet.length; i++) {
        lookup[alphabet.charCodeAt(i)] = i;
        for (let ch = 0; ch < 3; ch++) {
            const offset = i * 6 + ch * 2;
            colors[i * 4 + ch] = parseInt(palette.slice(offset, offset + 2), 16);
        }
        colors[i * 4 + 3] = 255;
    }
    const width = rows[0].length;
    const pixels = new Uint8Array(width * rows.length * 4);
    const entries = new Uint32Array(colors.buffer);
    const output = new Uint32Array(pixels.buffer);
    let i = 0;
    for (const row of rows)
        for (let x = 0; x < width; x++) output[i++] = entries[lookup[row.charCodeAt(x)]];
    const texture = new THREE.DataTexture(pixels, width, rows.length, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
}
module.exports = { createSurfacePreview };
