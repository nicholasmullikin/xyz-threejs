// Experimental water-only render targets. The interactive runtime creates these
// on demand. The compact blog globe does not instantiate this module.
const cloudSampling = `
#ifdef EARTH_WATER_CLOUDS
uniform sampler2D waterCloudMap;
uniform vec3 waterEast,waterNorth,waterUp;
uniform float waterCloudReady;
vec2 cloudReflectionUV(vec3 dir){
 float az=atan(dot(dir,waterNorth),dot(dir,waterEast)+1.e-8);
 vec2 uv=vec2(az/6.2831853+.5,sqrt(max(0.,dot(dir,waterUp))));
 return uv;
}
vec4 cloudReflectionSample(vec3 dir){return texture2D(waterCloudMap,cloudReflectionUV(dir));}
vec3 reflectedClouds(vec3 sky,vec3 dir,float roughness){
 if(waterCloudReady<.5)return sky;
 vec2 uv=cloudReflectionUV(dir);
 #if __VERSION__ >= 300
 vec4 cloud=textureLod(waterCloudMap,uv,log2(max(1.,roughness*17.)));
 #else
 vec4 cloud=texture2D(waterCloudMap,uv);
 #endif
 vec3 encoded=cloud.rgb/max(.0039,cloud.a);
 return mix(sky,encoded*encoded*4.,cloud.a);
}
#endif`;
const planarSampling = `
#ifdef EARTH_WATER_PLANAR
uniform mat4 waterProjection;
uniform vec3 waterOrigin,waterPlaneUp;
uniform sampler2D waterScene;
uniform float waterSceneReady;
vec3 shoreRadiance(vec4 sampleColor,float cover){
 vec3 encoded=min(vec3(.997),sampleColor.rgb/max(.004,cover));
 vec3 square=encoded*encoded;
 return cover*square/max(vec3(.004),1.-square);
}
vec3 reflectedShore(vec3 sky,vec3 world,vec3 outgoing,float roughness){
 if(waterSceneReady<.5)return sky;
 vec3 local=(world-waterOrigin)*1000.;
 float h=dot(local,waterPlaneUp);
 float confidence=(1.-smoothstep(2.,7.,abs(h)))*(1.-smoothstep(2200.,3600.,length(local)));
 if(confidence<.001)return sky;
 vec4 clip=waterProjection*vec4(local-h*waterPlaneUp,1.);
 if(clip.w<=0.)return sky;
 vec2 baseUv=clip.xy/clip.w*.5+.5;
 vec4 first=texture2D(waterScene,baseUv);
 // Alpha stores the logarithm of mirrored-camera view depth. A nearby
 // quay and a distant hillside should distort by different amounts.
 float depth=exp2(clamp((first.a-.5)*2.,0.,1.)*13.);
 float distanceToWater=length(world-cameraKm)*1000.;
 float travel=first.a>.5?max(0.,depth/clip.w-1.)*distanceToWater:350.;
 vec4 hit=clip+waterProjection*vec4(outgoing*min(travel,3500.),0.);
 vec2 uv=hit.xy/max(.1,hit.w)*.5+.5;
 uv=baseUv+clamp(uv-baseUv,vec2(-.07),vec2(.07));
 vec2 border=min(uv,1.-uv);
 confidence*=smoothstep(.005,.07,min(border.x,border.y));
 if(confidence<=0.)return sky;
 vec2 spread=vec2(.0015,.005)*sqrt(roughness)*clamp(travel/90.,.1,1.);
 vec4 a=texture2D(waterScene,uv+spread),b=texture2D(waterScene,uv-spread);
 float ca=smoothstep(0.,.5,a.a),cb=smoothstep(0.,.5,b.a);
 vec3 background=sky;
 // The water polygon and the terrain shoreline seldom meet exactly.
 // Only fill missing coverage near a caster at the water pixel's own depth.
 // Distant silhouettes still expose the sky behind them.
 if(min(ca,cb)<.999){
   vec2 offset=vec2(0.,.030);
   vec4 hi=texture2D(waterScene,uv+offset),lo=texture2D(waterScene,uv-offset);
   vec4 edge=hi.a>lo.a?hi:lo;
   float edgeDepth=exp2(clamp((edge.a-.5)*2.,0.,1.)*13.);
   float nearShore=1.-smoothstep(.12,.45,abs(edgeDepth-clip.w)/max(8.,clip.w));
   if(edge.a>.51)background=mix(sky,shoreRadiance(edge,1.),nearShore);
 }
 vec3 reflected=.5*(shoreRadiance(a,ca)+shoreRadiance(b,cb))+(1.-.5*(ca+cb))*background;
 return mix(sky,reflected,confidence);
}
#endif`;
function renderTo(renderer, target, scene, camera, THREE) {
    const viewport = renderer.getViewport(new THREE.Vector4()),
        scissor = renderer.getScissor(new THREE.Vector4());
    const clear = renderer.getClearColor(new THREE.Color()),
        alpha = renderer.getClearAlpha();
    const old = renderer.getRenderTarget(),
        test = renderer.getScissorTest(),
        auto = renderer.autoClear;
    try {
        renderer.setRenderTarget(target);
        renderer.setClearColor(0, 0);
        renderer.setScissorTest(false);
        renderer.autoClear = true;
        renderer.render(scene, camera);
    } finally {
        renderer.setRenderTarget(old);
        renderer.setViewport(viewport);
        renderer.setScissor(scissor);
        renderer.setScissorTest(test);
        renderer.setClearColor(clear, alpha);
        renderer.autoClear = auto;
    }
}
function cloudProbe(THREE, map, sky, env) {
    const uniform = value => ({ value });
    const uniforms = {
        waterEast: uniform(new THREE.Vector3()),
        waterNorth: uniform(new THREE.Vector3()),
        waterUp: uniform(new THREE.Vector3()),
        waterCloudMap: uniform(null),
        waterCloudReady: uniform(0)
    };
    const stats = { draws: 0, bytes: 0 };
    const origin = uniform(new THREE.Vector3()),
        bounds = uniform(new THREE.Vector2());
    const material = new THREE.ShaderMaterial({
        uniforms: { ...sky.uniforms, ...env.uniforms, ...uniforms, origin, bounds },
        depthTest: false,
        depthWrite: false,
        defines: { ATMOSPHERE_STEPS: 8, EARTH_REGIONAL_CLOUDS: 0 },
        vertexShader:
            "varying vec2 coord;void main(){coord=uv;gl_Position=vec4(position.xy,0.,1.);}",
        fragmentShader: `precision highp float; varying vec2 coord;
uniform vec3 origin,waterEast,waterNorth,waterUp;uniform vec2 bounds;
const float cloudCameraAltitude=0.;
${require("./atmosphere").glsl}
${require("./environment").glsl}
${require("./cloud-model").densityGLSL}
${require("./cloud-lighting").glsl}
void main(){
 float az=(coord.x-.5)*6.2831853, v=coord.y*coord.y;
 vec3 dir=waterUp*v+(waterEast*cos(az)+waterNorth*sin(az))*sqrt(1.-v*v);
 float climate=cloudClimate(origin),lo=max(0.,sphereInterval(origin,dir,planetRadius+bounds.x*climate).y);
 float hi=min(290.,sphereInterval(origin,dir,planetRadius+bounds.y*climate).y);
 float stepSize=max(0.,hi-lo)/18., trans=1.,weightedDensity=0.;vec3 point=vec3(0.);
 for(int i=0;i<18;i++){
   float t=lo+(float(i)+.5)*stepSize;vec3 p=origin+dir*t;
   float density=cloudDensity(p,t),opacity=1.-exp(-density*stepSize);
   weightedDensity+=density*trans*opacity;point+=p*trans*opacity;trans*=1.-opacity;if(trans<.015)break;
 }
 float weight=1.-trans;
 if(weight<.004){gl_FragColor=vec4(0.);return;}
 vec3 p=point/weight,up=normalize(p);
 float height=max(0.,length(p)-planetRadius);
 vec3 lightDir=cloudLightDirection(dot(up,sunDirection)+sqrt(2.*height/planetRadius));
 float distanceToLight=mix(2.2,1.4,smoothstep(.04,.55,abs(dot(up,lightDir))));
 float shadeDensity=cloudDensity(p+lightDir*distanceToLight,lo);
 vec3 light=cloudRadiance(p,dir,lightDir,weightedDensity/weight,shadeDensity,shadeDensity*distanceToLight,weight);
 gl_FragColor=vec4(sqrt(clamp(light*.25,0.,1.))*weight,weight);
}`
    });
    const scene = new THREE.Scene(),
        camera = new THREE.Camera(),
        geometry = new THREE.PlaneGeometry(2, 2);
    scene.userData.earthPass = "waterClouds";
    scene.add(new THREE.Mesh(geometry, material));
    let target,
        last = -Infinity,
        lastTime = -Infinity,
        preset,
        weather,
        noise;
    const sun = new THREE.Vector3(),
        scratch = new THREE.Vector3();
    function update(on, now) {
        if (!on || !env.uniforms.cloudsEnabled.value || !env.status.noiseReady) {
            uniforms.waterCloudReady.value = 0;
            return;
        }
        const kind = env.uniforms.cloudPreset.value;
        const p = map.worldTarget;
        if (
            uniforms.waterCloudReady.value &&
            Math.abs(lastTime - env.uniforms.cloudTime.value) < 1.5 &&
            origin.value.distanceToSquared(scratch.copy(p).multiplyScalar(0.001)) < 0.16 &&
            sun.dot(sky.uniforms.sunDirection.value) > 0.99998 &&
            preset === kind &&
            weather === env.uniforms.cloudMap.value &&
            noise === env.uniforms.cloudNoise.value
        )
            return;
        if (uniforms.waterCloudReady.value && now - last < 180) return;
        if (!target) {
            target = new THREE.WebGLRenderTarget(128, 32, {
                depthBuffer: false,
                stencilBuffer: false,
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter,
                wrapS: THREE.RepeatWrapping
            });
            target.texture.generateMipmaps = true;
            target.texture.minFilter = THREE.LinearMipmapLinearFilter;
            uniforms.waterCloudMap.value = target.texture;
        }
        const up = uniforms.waterUp.value.copy(p).normalize(),
            east = uniforms.waterEast.value;
        east.set(-up.y, up.x, 0);
        if (east.lengthSq() < 1e-10) east.set(1, 0, 0);
        east.normalize();
        uniforms.waterNorth.value.crossVectors(up, east);
        origin.value.copy(p).multiplyScalar(0.001);
        const deck = env.cloudPresets.find(row => row.id === kind);
        bounds.value.set(deck?.base ?? 0.35, deck?.top ?? 18);
        renderTo(map.renderer, target, scene, camera, THREE);
        stats.draws++;
        stats.bytes = 21852;
        lastTime = env.uniforms.cloudTime.value;
        uniforms.waterCloudReady.value = 1;
        sun.copy(sky.uniforms.sunDirection.value);
        preset = kind;
        weather = env.uniforms.cloudMap.value;
        noise = env.uniforms.cloudNoise.value;
        last = now;
    }
    const restored = () => {
        uniforms.waterCloudReady.value = 0;
        map.update();
    };
    map.canvas.addEventListener("webglcontextrestored", restored);
    return {
        uniforms,
        stats,
        update,
        dispose() {
            map.canvas.removeEventListener("webglcontextrestored", restored);
            target?.dispose();
            geometry.dispose();
            material.dispose();
        }
    };
}
module.exports = { cloudProbe, cloudSampling, planarSampling, renderTo };
