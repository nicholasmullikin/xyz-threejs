/* Orbital-only view cache. Terrain keeps direct integration for accurate local depth.
 * Two atlas halves store scattering and transmission, with no float-target dependency.
 */
const sampleGLSL = `
uniform sampler2D atmosphereCache;
uniform vec2 atmosphereCacheSize,atmosphereViewport;
void cachedAtmosphere(vec2 uv,out vec3 scatter,out vec3 transmission){
 vec2 pixel=clamp(uv,vec2(.5)/atmosphereCacheSize,vec2(1.)-vec2(.5)/atmosphereCacheSize);
 vec3 encoded=texture2D(atmosphereCache,vec2(pixel.x,pixel.y*.5)).rgb;
 scatter=encoded/max(vec3(.001),vec3(1.)-encoded);
 transmission=texture2D(atmosphereCache,vec2(pixel.x,pixel.y*.5+.5)).rgb;
}
`;
function createCache(THREE, map, uniforms, glsl) {
    const renderer = map.renderer;
    const target = new THREE.WebGLRenderTarget(1, 1, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false
    });
    uniforms.atmosphereCache = { value: target.texture };
    uniforms.atmosphereCacheSize = { value: new THREE.Vector2(1, 1) };
    uniforms.atmosphereViewport = { value: new THREE.Vector2(1, 1) };
    const material = new THREE.ShaderMaterial({
        uniforms,
        defines: { ATMOSPHERE_STEPS: 24, ATMOSPHERE_VARIABLE_STEPS: 1 },
        depthTest: false,
        depthWrite: false,
        vertexShader:
            "varying vec2 ndc;void main(){ndc=position.xy;gl_Position=vec4(position.xy,0.,1.);}",
        fragmentShader: `precision highp float;varying vec2 ndc;uniform mat4 inverseProjection;uniform mat3 cameraRotation;float atmosphereSteps;${glsl}
void main(){
 float v=ndc.y*.5+.5;vec2 rayNdc=vec2(ndc.x,fract(v*2.)*2.-1.);
 vec3 dir=normalize(cameraRotation*(inverseProjection*vec4(rayNdc,1.,1.)).xyz);
 vec2 ground=sphereInterval(cameraKm,dir,planetRadius);
 if(ground.x<=0.){gl_FragColor=vec4(v<.5?vec3(0.):vec3(1.),1.);return;}
 atmosphereSteps=12.;
 vec3 transmission;vec3 scatter=atmosphere(cameraKm,dir,ground.x>0.?ground.x:1e8,transmission);
 gl_FragColor=vec4(v<.5?scatter/(vec3(1.)+scatter):transmission,1.);
}`
    });
    const geometry = new THREE.PlaneGeometry(2, 2),
        scene = new THREE.Scene();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.userData.earthPass = "atmosphere";
    scene.add(mesh);
    const lastCamera = new THREE.Vector3(),
        lastSun = new THREE.Vector3(),
        lastRotation = new THREE.Matrix3(),
        lastProjection = new THREE.Matrix4();
    const viewport = new THREE.Vector4(),
        scissor = new THREE.Vector4();
    let valid = false,
        draws = 0;
    const invalidate = () => {
        valid = false;
    };
    map.canvas.addEventListener("webglcontextrestored", invalidate);
    return {
        get draws() {
            return draws;
        },
        update() {
            const size = uniforms.atmosphereViewport.value;
            renderer.getDrawingBufferSize(size);
            // Cache smooth surface haze; the sky and horizon integrate directly.
            // This budget excludes the two atlas halves.
            const scale = Math.min(0.5, Math.sqrt(60000 / Math.max(1, size.x * size.y)));
            const width = Math.max(1, Math.floor(size.x * scale)),
                height = Math.max(1, Math.floor(size.y * scale));
            if (target.width !== width || target.height !== height * 2) {
                target.setSize(width, height * 2);
                uniforms.atmosphereCacheSize.value.set(width, height);
                valid = false;
            }
            if (
                valid &&
                lastCamera.equals(uniforms.cameraKm.value) &&
                lastSun.equals(uniforms.sunDirection.value) &&
                lastRotation.equals(uniforms.cameraRotation.value) &&
                lastProjection.equals(map.camera.projectionMatrix)
            )
                return;
            const previous = renderer.getRenderTarget(),
                scissorTest = renderer.getScissorTest(),
                autoClear = renderer.autoClear;
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
                renderer.autoClear = autoClear;
            }
            lastCamera.copy(uniforms.cameraKm.value);
            lastSun.copy(uniforms.sunDirection.value);
            lastRotation.copy(uniforms.cameraRotation.value);
            lastProjection.copy(map.camera.projectionMatrix);
            valid = true;
            draws++;
        },
        dispose() {
            map.canvas.removeEventListener("webglcontextrestored", invalidate);
            target.dispose();
            material.dispose();
            geometry.dispose();
        }
    };
}
module.exports = { createCache, sampleGLSL };
