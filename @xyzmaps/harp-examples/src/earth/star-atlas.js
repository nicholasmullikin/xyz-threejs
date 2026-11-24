// Rasterize the bright-star catalogue into RGB5_A1. Each workgroup covers one
// star, including wraparound at the meridian and the latitude-dependent width.
const width = 2048,
    height = 1024;
async function gpuStars(THREE, adapter, signal) {
    const response = await fetch("resources/earth/bright-stars.bin", { signal });
    if (!response.ok) throw Error("Star catalogue unavailable");
    const catalog = await response.arrayBuffer();
    if (!catalog.byteLength || catalog.byteLength % 8) throw Error("Invalid star catalogue");
    const device = await adapter.requestDevice();
    let input, output, readback;
    try {
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const shader = device.createShaderModule({
            code: `
@group(0) @binding(0) var<storage,read> stars:array<vec2u>;
@group(0) @binding(1) var<storage,read_write> pixels:array<atomic<u32>>;
@compute @workgroup_size(1,8) fn main(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_id) local:vec3u){
    let record=stars[group.x];
    let uv=vec2f(f32(record.x & 65535u),f32(record.x>>16u))/65535.;
    let center=uv*vec2f(2048.,1024.);
    let photo=unpack4x8unorm(record.y);
    let sigma=.35+.48*sqrt(photo.a);
    let scale=max(.045,cos((uv.y-.5)*3.14159265));
    let y=i32(floor(center.y))-3+i32(local.y);
    if(y<0 || y>=1024){return;}
    let dy=(f32(y)+.5-center.y)/sigma;
    let start=i32(floor(center.x-3.*sigma/scale));let end=i32(ceil(center.x+3.*sigma/scale));
    for(var x=start;x<end;x++){
        let dx=(f32(x)+.5-center.x)*scale/sigma;let r2=dx*dx+dy*dy;
        if(r2>9.){continue;}
        let rgb=vec3u(round(photo.rgb*photo.a*exp(-.5*r2)*vec3f(31.)));
        let packed=(rgb.r<<11u)|(rgb.g<<6u)|(rgb.b<<1u)|1u;
        let idx=u32(y*2048+((x+2048)%2048));
        let shift=(idx&1u)*16u;let mask=65535u<<shift;
        var old=atomicLoad(&pixels[idx>>1u]);
        loop {
            let present=(old>>shift)&65535u;
            if(present>=packed){break;}
            let result=atomicCompareExchangeWeak(&pixels[idx>>1u],old,(old & ~mask)|(packed<<shift));
            if(result.exchanged){break;}
            old=result.old_value;
        }
    }
}`
        });
        const pipeline = await device.createComputePipelineAsync({
            layout: "auto",
            compute: { module: shader, entryPoint: "main" }
        });
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const size = width * height * 2;
        input = device.createBuffer({
            size: catalog.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(input, 0, catalog);
        output = device.createBuffer({
            size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        readback = device.createBuffer({
            size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });
        const group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: input } },
                { binding: 1, resource: { buffer: output } }
            ]
        });
        const encoder = device.createCommandEncoder(),
            pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(catalog.byteLength / 8);
        pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, size);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
        const pixels = new Uint16Array(readback.getMappedRange().slice(0));
        const texture = new THREE.DataTexture(
            pixels,
            width,
            height,
            THREE.RGBAFormat,
            THREE.UnsignedShort5551Type
        );
        texture.userData.starSource = "webgpu";
        return texture;
    } finally {
        input?.destroy();
        output?.destroy();
        readback?.destroy();
        device.destroy();
    }
}
async function createStarAtlas(THREE, signal) {
    if (navigator.gpu && !navigator.connection?.saveData) {
        try {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
            if (adapter) return configure(THREE, await gpuStars(THREE, adapter, signal));
        } catch (error) {
            if (signal.aborted) throw error;
        }
    }
    const loader = require("./textures").createTextureLoader(THREE);
    return new Promise((resolve, reject) => {
        const abort = () => {
            loader.dispose();
            reject(new DOMException("Cancelled", "AbortError"));
        };
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        const finish = () => signal.removeEventListener("abort", abort);
        loader.load(
            "resources/earth/bright-stars.webp",
            texture => {
                finish();
                texture.userData.starSource = "catalogue";
                resolve(configure(THREE, texture));
            },
            undefined,
            error => {
                finish();
                reject(error);
            }
        );
    });
}
function configure(THREE, texture) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
}
module.exports = { createStarAtlas };
