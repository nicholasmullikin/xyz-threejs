// WebGL ignores UNPACK_FLIP_Y_WEBGL for ImageBitmap. Decode in upload
// orientation, keeping Canvas2D fade snapshots in geographic north-up order.
const bitmaps = new WeakMap();
function releaseBitmap(texture) {
    const image = bitmaps.get(texture);
    if (!image) return;
    image.close();
    bitmaps.delete(texture);
    texture.removeEventListener("dispose", onDispose);
}
function onDispose(event) {
    releaseBitmap(event.target);
}
function drawRaster(ctx, texture, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (texture.isCompressedTexture) return require("./compressed-pages").drawCompressed(ctx, texture, sx, sy, sw, sh, dx, dy, dw, dh);
    const image = texture.image;
    if (!bitmaps.has(texture)) {
        ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
        return;
    }
    ctx.save();
    ctx.translate(dx, dy + dh);
    ctx.scale(1, -1);
    ctx.drawImage(image, sx, image.height - sy - sh, sw, sh, 0, 0, dw, dh);
    ctx.restore();
}
/** Abortable image loading. Texture ownership transfers to the successful caller. */
function createTextureLoader(THREE) {
    const requests = new Set();
    let disposed = false;
    return {
        load(url, onLoad, onProgress, onError = () => {}, options = {}) {
            if (disposed) return;
            const controller = new AbortController(),
                request = { controller, image: null };
            requests.add(request);
            const { bitmap = false, stallMs = bitmap ? 15000 : 0 } = options;
            let objectUrl,
                encodedBytes,
                flipped = false,
                timer,
                phase = "transfer";
            let receivedBytes = 0,
                lastProgress = performance.now();
            const finish = () => {
                clearTimeout(timer);
                requests.delete(request);
                if (objectUrl) {
                    URL.revokeObjectURL(objectUrl);
                    objectUrl = undefined;
                }
            };
            const cancel = () => {
                if (controller.signal.aborted) return;
                controller.abort();
                if (request.image) {
                    request.image.onerror?.();
                    request.image.onload = null;
                    request.image.onerror = null;
                    request.image.src = "";
                }
                finish();
            };
            request.cancel = cancel;
            function checkProgress() {
                const remaining = stallMs - (performance.now() - lastProgress);
                if (remaining > 0) {
                    timer = setTimeout(checkProgress, remaining);
                    return;
                }
                cancel();
                if (!disposed)
                    onError(
                        Object.assign(new Error(`Texture ${phase} stalled`), { stalled: phase })
                    );
            }
            if (stallMs) timer = setTimeout(checkProgress, stallMs);
            const { rasterBlob, httpError } = require("./raster-request");
            const download = stallMs
                ? rasterBlob(url, controller.signal, event => {
                      if (!event || event.loaded > receivedBytes) {
                          lastProgress = performance.now();
                          receivedBytes = event?.loaded ?? 0;
                      }
                      if (event && onProgress) onProgress(event);
                  })
                : fetch(url, { signal: controller.signal }).then(response => {
                      if (!response.ok) throw httpError(response.status, response.headers);
                      return response.blob();
                  });
            download
                .then(async blob => {
                    if (disposed || controller.signal.aborted) return;
                    encodedBytes = blob.size;
                    lastProgress = performance.now();
                    phase = "decode";
                    if (options.compress) {
                        const compressed = await options.compress.prepare(blob, controller.signal);
                        if (compressed) {
                            flipped = !compressed.isCompressedTexture;
                            return compressed;
                        }
                        if (disposed || controller.signal.aborted) return;
                    }
                    if (bitmap && typeof createImageBitmap === "function") {
                        try {
                            const image = await createImageBitmap(blob, {
                                imageOrientation: "flipY",
                                premultiplyAlpha: "none",
                                colorSpaceConversion: "none"
                            });
                            flipped = true;
                            return image;
                        } catch {
                            if (disposed || controller.signal.aborted) return;
                            // Browsers and codecs can implement different bitmap
                            // options. The HTML decoder retains the original path.
                        }
                    }
                    return new Promise((resolve, reject) => {
                        const image = (request.image = new Image());
                        image.onload = () => resolve(image);
                        image.onerror = () => reject(Error("Texture image decoding failed"));
                        objectUrl = URL.createObjectURL(blob);
                        image.src = objectUrl;
                    });
                })
                .then(image => {
                    if (disposed || controller.signal.aborted) {
                        if (image?.isCompressedTexture) image.dispose();
                        else if (flipped) image.close();
                        return;
                    }
                    const texture = image.isCompressedTexture ? image : new THREE.Texture(image);
                    if (flipped) {
                        texture.flipY = false;
                        bitmaps.set(texture, image);
                        texture.addEventListener("dispose", onDispose);
                    }
                    texture.userData.encodedBytes = encodedBytes;
                    texture.needsUpdate = true;
                    onLoad(texture);
                })
                .catch(error => {
                    if (!disposed && !controller.signal.aborted && error.name !== "AbortError")
                        onError(error);
                })
                .finally(finish);
            return cancel;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const request of requests) request.cancel();
            requests.clear();
        }
    };
}
// Conservative RGBA8 residency, including mip levels. The driver may allocate more.
function estimatedBytes(texture) {
    if (texture.userData?.blockBytes) return texture.userData.blockBytes;
    let width = texture.image?.width || 0,
        height = texture.image?.height || 0,
        bytes = 0;
    if (!width || !height) return 0;
    bytes = width * height * 4;
    while (texture.generateMipmaps && (width > 1 || height > 1)) {
        width = Math.max(1, Math.floor(width / 2));
        height = Math.max(1, Math.floor(height / 2));
        bytes += width * height * 4;
    }
    return bytes;
}
module.exports = { createTextureLoader, estimatedBytes, releaseBitmap, drawRaster };
