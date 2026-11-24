// ETOPO ocean shading shares the optional panorama's alpha channel. The
// layer uses the same sampler on WebGL1 and adds no default data requests.
const glsl = `
uniform float oceanReliefWeight;
vec3 oceanCartography(vec3 albedo, sampler2D panorama, vec2 uv){
 if(oceanReliefWeight<=0.)return albedo;
 float code=samplePanorama(panorama,uv).a;
 float mask=1.-smoothstep(.81,.995,code);
 float value=clamp((code*255.-28.)/180.,0.,1.);
 vec3 blue=mix(vec3(.050,.132,.224),vec3(.31,.50,.59),value);
 return mix(albedo,pow(blue,vec3(2.2)),oceanReliefWeight*mask);
}`;
function createRelief(THREE, loader, map, changed) {
    let texture, cancel, timer, retry, enabled = false, regional = false, disposed = false;
    function release() {
        timer = undefined;
        if (enabled && regional) return;
        texture?.dispose();
        texture = undefined;
    }
    function update() {
        if (disposed) return;
        if (!enabled || !regional) {
            cancel?.();
            cancel = undefined;
            clearTimeout(retry);
            retry = undefined;
            if (texture && timer === undefined) timer = setTimeout(release, 15000);
            return;
        }
        clearTimeout(timer);
        timer = undefined;
        if (texture || cancel || retry !== undefined) return;
        cancel = loader.load("/earth-background/surface-relief.webp", result => {
            cancel = undefined;
            if (disposed || !enabled || !regional) {
                result.dispose();
                return;
            }
            result.wrapS = THREE.RepeatWrapping;
            result.minFilter = THREE.LinearMipmapLinearFilter;
            result.magFilter = THREE.LinearFilter;
            result.generateMipmaps = true;
            result.anisotropy = Math.min(8,map.renderer.capabilities.getMaxAnisotropy());
            texture = result;
            changed();
        }, undefined, () => {
            cancel = undefined;
            retry = setTimeout(() => { retry = undefined; update(); }, 30000);
        }, {bitmap:true});
    }
    return {
        set(on) {
            if (enabled === on) return;
            enabled = on;
            update();
            changed();
        },
        setRegional(value) {
            if (regional === value) return;
            regional = value;
            update();
        },
        get texture() {return enabled && regional ? texture : undefined;},
        dispose() {
            disposed = true;
            cancel?.();
            clearTimeout(timer);
            clearTimeout(retry);
            texture?.dispose();
        }
    };
}
module.exports = {glsl,createRelief};
