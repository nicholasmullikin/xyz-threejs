// Satellite pages stay JPEG/WebP on the wire. Encode bounded local mip chains
// only after the initial decode, in WebGL upload orientation.
let encoder, active, canvas, context;
const queue = [];
function getEncoder(codec) {
    if (codec !== "bc7" && codec !== "etc2") throw Error("Unknown texture encoder");
    encoder ??= fetch("resources/earth/page-" + codec + ".wasm")
        .then(response => {
            if (!response.ok) throw Error("Page encoder unavailable");
            return response.arrayBuffer();
        })
        .then(bytes => WebAssembly.instantiate(bytes))
        .then(module => module.instance.exports);
    return encoder;
}
async function compress(job) {
    const native = await getEncoder(job.codec);
    if (job.canceled) return;
    const image = await createImageBitmap(job.blob, {
        imageOrientation: "flipY",
        premultiplyAlpha: "none",
        colorSpaceConversion: "none"
    });
    let keepBitmap = false;
    try {
        if (job.canceled) return;
        const { width, height } = image;
        if (!canvas) {
            canvas = new OffscreenCanvas(width, height);
            context = canvas.getContext("2d", { willReadFrequently: true });
        }
        if (width === height && (width === 256 || width === 512) && context) {
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
            }
            context.clearRect(0, 0, width, height);
            context.drawImage(image, 0, 0);
            const rgba = context.getImageData(0, 0, width, height).data;
            let opaque = true;
            for (let i = 3; i < rgba.length; i += 4) {
                if (rgba[i] !== 255) {
                    opaque = false;
                    break;
                }
            }
            if (opaque) {
                const source = native.__heap_base.value,
                    output = source + rgba.byteLength;
                const memory = new Uint8Array(native.memory.buffer);
                memory.set(rgba, source);
                const length = native.encode(source, width, height, output, 1);
                // Complex high-contrast pages can exceed ETC2's four-color
                // palette. Keep the original bitmap below ~32dB source PSNR.
                if (length && (job.codec !== "etc2" || native.mean_squared_error() <= 40))
                    return { width, height, bytes: memory.slice(output, output + length) };
            }
        }
        keepBitmap = true;
        return { image };
    } finally {
        if (!keepBitmap) image.close();
    }
}
async function pump() {
    if (active) return;
    while (queue.length) {
        active = queue.shift();
        const { id } = active;
        try {
            const result = active.canceled ? undefined : await compress(active);
            if (active.canceled) result?.image?.close();
            const keep = active.canceled ? undefined : result;
            const transfer = keep?.image || keep?.bytes.buffer;
            self.postMessage({ id, result: keep }, transfer ? [transfer] : []);
        } catch {
            self.postMessage({ id, error: true });
        } finally {
            active = undefined;
        }
    }
}
self.onmessage = ({ data }) => {
    if (data.cancel) {
        const job = active?.id === data.id ? active : queue.find(item => item.id === data.id);
        if (job) job.canceled = true;
        return;
    }
    queue.push(data);
    void pump();
};
