const { drawCompressed } = require("./page-snapshot");

const codecs = {
    bc7: { extension: "EXT_texture_compression_bptc", format: "RGBA_BPTC_Format", blockBytes: 16 },
    etc2: { extension: "WEBGL_compressed_texture_etc", format: "RGB_ETC2_Format", blockBytes: 8 }
};
function makeTexture(THREE, codec, result) {
    const { width, height, bytes } = result;
    if (width !== height || (width !== 256 && width !== 512) || !(bytes instanceof Uint8Array))
        return;
    const levels = [];
    let offset = 0;
    for (let size = width; size >= 1; size = Math.floor(size / 2)) {
        const length = codecs[codec].blockBytes * Math.ceil(size / 4) ** 2;
        levels.push({ width: size, height: size, data: bytes.subarray(offset, offset + length) });
        offset += length;
    }
    if (offset !== bytes.byteLength) return;
    const texture = new THREE.CompressedTexture(levels, width, height, THREE[codecs[codec].format]);
    texture.userData.blockBytes = offset;
    texture.userData.pageCodec = codec;
    texture.flipY = false;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
}
function createCompressedPages(THREE, map, preference = "bc7") {
    if (typeof Worker !== "function" || typeof WebAssembly !== "object") return;
    const choices = preference === "auto" ? ["bc7", "etc2"] : [preference];
    const codec = choices.find(
        type => Object.hasOwn(codecs, type) && map.renderer.extensions.has(codecs[type].extension)
    );
    if (!codec) return;
    const pending = new Map();
    let worker,
        nextId = 0,
        disabled = false;
    function finish(id, value) {
        const job = pending.get(id);
        if (!job) return;
        clearTimeout(job.timer);
        job.signal.removeEventListener("abort", job.abort);
        pending.delete(id);
        job.resolve(value);
    }
    function stop() {
        disabled = true;
        worker?.terminate();
        worker = undefined;
        for (const id of pending.keys()) finish(id);
    }
    function receive({ data }) {
        const job = pending.get(data?.id);
        if (!job || job.signal.aborted) {
            data?.result?.image?.close();
            if (job) finish(data.id);
            return;
        }
        if (data.error) {
            stop();
            return;
        }
        try {
            const result = data.result;
            finish(data.id, result?.image || (result && makeTexture(THREE, codec, result)));
        } catch {
            stop();
        }
    }
    return {
        codec,
        prepare(blob, signal) {
            // Exact uniform detection is cheaper than block encoding. An
            // aborted job retains its worker credit until acknowledged, so a
            // fast pan cannot leave a hidden CPU/decode backlog.
            if (disabled || signal.aborted || blob.size <= 8000 || pending.size >= 4) return;
            if (!worker) {
                try {
                    worker = new Worker(require("./worker-url").earthWorkerUrl("earth-bc7"));
                } catch {
                    stop();
                    return;
                }
                worker.onerror = worker.onmessageerror = stop;
                worker.onmessage = receive;
            }
            return new Promise(resolve => {
                const id = ++nextId;
                function abort() {
                    resolve();
                    try {
                        worker?.postMessage({ id, cancel: true });
                    } catch {
                        stop();
                    }
                }
                const timer = setTimeout(stop, 6000);
                pending.set(id, { resolve, signal, abort, timer });
                signal.addEventListener("abort", abort, { once: true });
                try {
                    worker.postMessage({ id, codec, blob });
                } catch {
                    stop();
                }
            });
        },
        dispose: stop
    };
}
module.exports = { createCompressedPages, drawCompressed, makeTexture };
