const size = 64;
function texture3D(THREE, data, width = size) {
    const texture = new THREE.Data3DTexture(data, width, width, width);
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.UnsignedByteType;
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
}
// Used for custom atlases and when worker-src is restricted. The ordinary
// WebGL2 path transfers the worker's contiguous volume directly to Three.
function fromAtlas(THREE, image) {
    if (image.width !== 528 || image.height !== 528) throw Error("Unexpected noise layout");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 528;
    const ctx = canvas.getContext("2d", {willReadFrequently:true});
    ctx.drawImage(image,0,0);
    const pixels = ctx.getImageData(0,0,528,528).data;
    const data = new Uint8Array(size**3*4);
    for (let z=0;z<size;z++){
        const column=z%8*66+1, row=Math.floor(z/8)*66+1;
        for(let y=0;y<size;y++){
            const offset=((row+y)*528+column)*4;
            data.set(pixels.subarray(offset,offset+size*4),(z*size+y)*size*4);
        }
    }
    return texture3D(THREE,data);
}
function generate(THREE, lifetime, ready, fallback) {
    let worker;
    try {worker = new Worker(require("./worker-url").earthWorkerUrl("earth-noise"));} catch {fallback();return;}
    // A blocked network or broken worker may never send an error.
    const timer = setTimeout(failed,5000);
    function stop() {clearTimeout(timer);worker.terminate();}
    function failed() {stop();if(!lifetime.disposed)fallback();}
    worker.onerror = failed;
    worker.onmessage = event => {
        stop();
        if(lifetime.disposed)return;
        if(!(event.data instanceof Uint8Array) || event.data.length !== size**3*4) {fallback();return;}
        ready(texture3D(THREE,event.data));
    };
    worker.postMessage(null);
    lifetime.own(stop);
}
module.exports={texture3D,fromAtlas,generate};
