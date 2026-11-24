// The finite-distance aerial lookup only consumes RGB. Store a local ground
// shadow field in the alpha channel of its lower 128 rows. This costs no extra
// sampler in a terrain draw and keeps the full procedural shadow outside it.
const coordinates = `
uniform vec3 shadeOrigin,shadeEast,shadeNorth,shadeUp;
uniform float shadeWidth,shadeActive;uniform vec2 shadeBand;
float shadeCache(vec3 p){
    if(shadeActive<.5)return -1.;
    vec3 delta=p-shadeOrigin;
    float altitude=dot(delta,shadeUp),cosine=dot(sunDirection,shadeUp);
    if(altitude<shadeBand.x||altitude>shadeBand.y||cosine<.09)return -1.;
    // Project along the sun ray onto the reference elevation. A roof and the
    // ground beneath it can cast rays through different parts of a low cloud.
    delta-=sunDirection*(altitude/cosine);
    vec2 uv=vec2(dot(delta,shadeEast),dot(delta,shadeNorth))/shadeWidth+.5;
    if(any(lessThan(uv,vec2(.01)))||any(greaterThan(uv,vec2(.99))))return -1.;
    return texture2D(aerialViewAtlas,uv*vec2(1.,1./3.)).a;
}`;
function shadowBand(preset, latitude, baseHeight, span) {
    const climate = 0.72 + 0.5 * Math.sqrt(Math.max(0, 1 - Math.abs(Math.sin(latitude))));
    const shells =
        preset < -0.5
            ? [1.5, 4.5, 9.5]
            : [preset < 0.5 ? 4 : preset < 3.5 ? 9 : preset < 6.5 ? 4.5 : preset < 9.5 ? 1.8 : 9];
    const guard = 0.025 + (span * span) / (4 * 6378.137);
    let low = -0.65,
        high = 0.65;
    for (const h of shells) {
        const offset = h * climate - baseHeight;
        if (Math.abs(offset) <= guard) return [0, 0];
        if (offset < 0) low = Math.max(low, offset + guard);
        else high = Math.min(high, offset - guard);
    }
    return [low, high];
}
function create(THREE, map, sky, environment, atmosphere, weather) {
    if (!sky.aerial) return;
    const renderer = map.renderer,
        target = sky.aerial.target,
        scalar = value => ({ value }),
        vec = () => scalar(new THREE.Vector3());
    const shared = {
        shadeOrigin: vec(),
        shadeEast: vec(),
        shadeNorth: vec(),
        shadeUp: vec(),
        shadeWidth: scalar(1),
        shadeActive: scalar(0),
        shadeBand: scalar(new THREE.Vector2())
    };
    Object.assign(sky.uniforms, shared);
    const uniforms = { ...environment.uniforms, ...sky.uniforms };
    const material = new THREE.ShaderMaterial({
        uniforms,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.OneFactor,
        blendEquationAlpha: THREE.AddEquation,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.ZeroFactor,
        defines: { ATMOSPHERE_STEPS: 1 },
        vertexShader: "void main(){gl_Position=vec4(position.xy,0.,1.);}",
        fragmentShader: `precision highp float; ${atmosphere} ${weather}
            uniform vec3 shadeOrigin,shadeEast,shadeNorth;uniform float shadeWidth;
            void main(){
                vec2 xy=(gl_FragCoord.xy/128.-.5)*shadeWidth;
                vec3 p=normalize(shadeOrigin+xy.x*shadeEast+xy.y*shadeNorth)*length(shadeOrigin);
                gl_FragColor=vec4(0.,0.,0.,cloudShadow(p));
            }`
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material),
        scene = new THREE.Scene();
    quad.frustumCulled = false;
    scene.add(quad);
    scene.userData.earthPass = "cloudGroundShadow";
    const view = new THREE.Vector4(),
        scissor = new THREE.Vector4(),
        focus = new THREE.Vector3(),
        lastSun = new THREE.Vector3();
    const { shadeOrigin, shadeEast, shadeNorth, shadeUp, shadeWidth, shadeActive } = shared;
    let revision = -1,
        lastTime = -Infinity,
        lastPreset,
        lastMap,
        enabled = true,
        updates = 0;
    function update(mode) {
        shadeActive.value = 0;
        if (
            !enabled ||
            mode !== "a" ||
            !uniforms.cloudsEnabled.value ||
            !environment.status.cloudReady ||
            !environment.status.noiseReady ||
            !uniforms.aerialViewEnabled.value ||
            map.zoomLevel < 9
        )
            return;
        const { latitude, longitude, altitude } = map.target,
            lat = (latitude * Math.PI) / 180,
            lon = (longitude * Math.PI) / 180;
        const c = Math.cos(lat);
        focus.set(c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat));
        const sun = uniforms.sunDirection.value;
        if (focus.dot(sun) < 0.09) return;
        focus.multiplyScalar(6378.137 + (altitude || 0) / 1000);
        const span = Math.max(10, Math.min(42, map.targetDistance * 0.0028)),
            now = uniforms.cloudTime.value,
            preset = uniforms.cloudPreset.value,
            coverage = uniforms.cloudMap.value;
        shadeActive.value = 1;
        if (
            sky.aerial.revision === revision &&
            lastPreset === preset &&
            lastMap === coverage &&
            now >= lastTime &&
            now - lastTime < 1.35 &&
            focus.distanceToSquared(shadeOrigin.value) < (span * 0.075) ** 2 &&
            Math.abs(span - shadeWidth.value) < span * 0.18 &&
            lastSun.distanceToSquared(sun) < 0.00000016
        )
            return;
        shadeOrigin.value.copy(focus);
        shadeUp.value.copy(focus).normalize();
        shadeEast.value.set(-Math.sin(lon), Math.cos(lon), 0);
        shadeNorth.value.crossVectors(shadeUp.value, shadeEast.value);
        shadeWidth.value = span;
        shared.shadeBand.value.fromArray(shadowBand(preset, lat, (altitude || 0) / 1000, span));
        const old = renderer.getRenderTarget(),
            clear = renderer.autoClear,
            sc = renderer.getScissorTest();
        renderer.getViewport(view);
        renderer.getScissor(scissor);
        const vp = target.viewport.clone();
        try {
            renderer.autoClear = false;
            target.viewport.set(0, 0, 128, 128);
            renderer.setRenderTarget(target);
            renderer.setScissorTest(false);
            renderer.render(scene, map.camera);
            updates++;
        } finally {
            target.viewport.copy(vp);
            renderer.setRenderTarget(old);
            renderer.autoClear = clear;
            renderer.setViewport(view);
            renderer.setScissor(scissor);
            renderer.setScissorTest(sc);
        }
        revision = sky.aerial.revision;
        lastPreset = preset;
        lastMap = coverage;
        lastSun.copy(sun);
        lastTime = now;
    }
    return {
        update,
        get updates() {
            return updates;
        },
        setEnabled(value) {
            enabled = value;
            revision = -1;
            map.update();
        },
        dispose() {
            shadeActive.value = 0;
            quad.geometry.dispose();
            material.dispose();
        }
    };
}
module.exports = { coordinates, create, shadowBand };
