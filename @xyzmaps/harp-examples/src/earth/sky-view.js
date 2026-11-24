// Ground sky-view lookup following Hillaire (EGSR 2020). In a spherical
// atmosphere the sky depends on height and solar zenith, independent of heading.
// Split scattering and transmission into two RGBA8 atlas halves for WebGL1.
const width = 128,
    height = 64;
const coordinates = `
uniform sampler2D skyViewAtlas;
uniform vec3 skyUp, skyForward, skyRight;
uniform float skyHorizon, skyViewEnabled;
void sampleSkyView(vec3 dir,out vec3 scatter,out vec3 trans){
 float elevation=asin(clamp(dot(dir,skyUp),-1.,1.));
 float azimuth=atan(abs(dot(dir,skyRight)),dot(dir,skyForward)+1e-9);
 vec2 uv=vec2(azimuth/3.14159265,sqrt(clamp((elevation-skyHorizon)/(1.57079633-skyHorizon),0.,1.)));
 uv=(uv*vec2(127.,63.)+.5)/vec2(128.,64.);
 vec3 packedLight=texture2D(skyViewAtlas,vec2(uv.x,uv.y*.5)).rgb;
 scatter=packedLight*packedLight/max(vec3(.001),1.-packedLight*packedLight);
 trans=texture2D(skyViewAtlas,vec2(uv.x,uv.y*.5+.5)).rgb;
}`;
function createSkyView(THREE, map, uniforms, glsl) {
    const renderer = map.renderer;
    const target = new THREE.WebGLRenderTarget(width, 2 * height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false
    });
    const up = new THREE.Vector3(),
        forward = new THREE.Vector3(),
        right = new THREE.Vector3();
    Object.assign(uniforms, {
        skyViewAtlas: { value: target.texture },
        skyUp: { value: up },
        skyForward: { value: forward },
        skyRight: { value: right },
        skyHorizon: { value: 0 },
        skyViewEnabled: { value: 0 }
    });
    const material = new THREE.ShaderMaterial({
        uniforms,
        defines: { ATMOSPHERE_STEPS: 24 },
        depthTest: false,
        depthWrite: false,
        vertexShader: "void main(){gl_Position=vec4(position.xy,0.,1.);}",
        fragmentShader: `precision highp float;${glsl}
uniform vec3 skyUp,skyForward,skyRight; uniform float skyHorizon;
void main(){
 vec2 pixel=floor(gl_FragCoord.xy);
 float azimuth=pixel.x*(3.14159265/127.);
 float t=mod(pixel.y,64.)/63.,e=mix(skyHorizon,1.57079633,t*t);
 vec3 dir=skyUp*sin(e)+(skyForward*cos(azimuth)+skyRight*sin(azimuth))*cos(e);
 vec3 trans;vec3 radiance=atmosphere(cameraKm,dir,1e8,trans);
 vec3 value=pixel.y<64.?sqrt(radiance/(1.+radiance)):trans;
 gl_FragColor=vec4(value,1.);
}`
    });
    const geometry = new THREE.PlaneGeometry(2, 2),
        scene = new THREE.Scene();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    scene.userData.earthPass = "atmosphere";
    const viewport = new THREE.Vector4(),
        scissor = new THREE.Vector4();
    let lastAltitude = Infinity,
        lastCosine = Infinity;
    const reset = () => {
        lastAltitude = Infinity;
    };
    map.canvas.addEventListener("webglcontextrestored", reset);
    function update() {
        const position = uniforms.cameraKm.value,
            sun = uniforms.sunDirection.value;
        const altitude = position.length() - 6378.137;
        uniforms.skyViewEnabled.value = altitude >= 0 && altitude < 50 ? 1 : 0;
        if (!uniforms.skyViewEnabled.value) return;
        up.copy(position).normalize();
        const cosine = up.dot(sun);
        forward.copy(sun).addScaledVector(up, -cosine);
        if (forward.lengthSq() < 1e-12) {
            forward.set(Math.abs(up.x) > 0.9 ? 0 : 1, Math.abs(up.x) > 0.9 ? 1 : 0, 0);
            forward.addScaledVector(up, -forward.dot(up));
        }
        forward.normalize();
        right.crossVectors(up, forward);
        uniforms.skyHorizon.value = -Math.acos(6378.137 / (6378.137 + altitude));
        if (Math.abs(altitude - lastAltitude) < 0.01 && Math.abs(cosine - lastCosine) < 0.0002)
            return;
        const previous = renderer.getRenderTarget(),
            scissorTest = renderer.getScissorTest(),
            auto = renderer.autoClear;
        renderer.getViewport(viewport);
        renderer.getScissor(scissor);
        try {
            renderer.setScissorTest(false);
            renderer.autoClear = false;
            renderer.setRenderTarget(target);
            renderer.render(scene, map.camera);
        } finally {
            renderer.setRenderTarget(previous);
            renderer.setViewport(viewport);
            renderer.setScissor(scissor);
            renderer.setScissorTest(scissorTest);
            renderer.autoClear = auto;
        }
        lastAltitude = altitude;
        lastCosine = cosine;
    }
    return {
        update,
        dispose() {
            map.canvas.removeEventListener("webglcontextrestored", reset);
            target.dispose();
            material.dispose();
            geometry.dispose();
        }
    };
}
module.exports = { coordinates, createSkyView };
