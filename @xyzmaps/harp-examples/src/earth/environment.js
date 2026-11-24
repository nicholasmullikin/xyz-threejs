const { noiseGLSL } = require("./cloud-model");
const { createNightDetail, scalarFormat } = require("./night-detail");
const { createClouds } = require("./clouds");
// Cloud wind is the only autonomous animation in the main map. User input,
// loading and fades retain their own immediate MapView updates.
function scheduleCloudWind(map, lifetime, active) {
    let visible = true,
        lastRequest = -Infinity,
        lastFrame = -1,
        averageGpu = 0,
        started = performance.now();
    if (typeof IntersectionObserver !== "undefined") {
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries)
                if (entry.target === map.canvas) visible = entry.isIntersecting;
        });
        observer.observe(map.canvas);
        lifetime.own(() => observer.disconnect());
    }
    lifetime.interval(() => {
        if (!visible || document.hidden || !active()) return;
        const now = performance.now();
        if (map.frameNumber !== lastFrame) {
            lastFrame = map.frameNumber;
            const gpu = map.earth?.performance?.gpuFrameMs();
            if (Number.isFinite(gpu)) averageGpu = averageGpu ? averageGpu * 0.8 + gpu * 0.2 : gpu;
        }
        // Bound sustained GPU occupancy to roughly 20% on slower devices,
        // without throttling input-driven frames or capable hardware.
        const interval =
            map.cameraIsMoving || now - started < 3000
                ? 50
                : Math.min(250, Math.max(50, averageGpu * 5));
        // Browser timers may fire a fraction of a millisecond early; do not
        // accidentally skip an entire 50 ms tick on a fast GPU.
        if (now - lastRequest + 2 < interval) return;
        lastRequest = now;
        map.update();
    }, 50);
}
/* NASA Black Marble emission and procedural volumetric clouds.
 * Geographic coverage can use the NOAA forecast; small-scale detail and wind are illustrative.
 */

const glsl = `
uniform sampler2D nightMap;
uniform sampler2D cloudMap;
uniform float cloudsEnabled;
uniform float lightsEnabled;
uniform float buildingLightBlend;
uniform float cloudTime;
vec2 earthUv(vec3 p){vec3 n=normalize(p);return vec2(atan(n.y,n.x)/6.283185307+.5,asin(clamp(n.z,-1.,1.))/3.141592654+.5);}
float nightWeight(vec3 p){return 1.-smoothstep(-.12,.025,dot(normalize(p),sunDirection));}
float localLights(float km){return buildingLightBlend*(1.-smoothstep(3.,13.,km));}
#ifdef EARTH_LOCAL_LIGHTS
uniform sampler2D nightDetailMap;
uniform vec2 nightCenter;
uniform float nightDetailFade;
#endif
float citySignal(vec3 p){
 vec2 uv=earthUv(p);float base=texture2D(nightMap,uv).r;
 #ifdef EARTH_LOCAL_LIGHTS
 vec2 pageUv=vec2(fract(uv.x-nightCenter.x+.5)-.5,uv.y-nightCenter.y)*vec2(8.,4.)+.5;
 vec2 edge=min(pageUv,1.-pageUv);
 float fade=nightDetailFade*smoothstep(0.,.04,min(edge.x,edge.y));
 if(fade>0.)base=mix(base,texture2D(nightDetailMap,pageUv).r,fade);
 #endif
 return base;
}
vec3 nightEmission(vec3 p){float night=nightWeight(p)*lightsEnabled;if(night<=0.)return vec3(0.);float signal=citySignal(p);return vec3(1.,.64,.27)*pow(max(0.,signal-.035),1.65)*2.7*night;}
${noiseGLSL}
float cloudCover(vec3 p){
 vec2 uv=earthUv(p);uv.x+=cloudTime*.000002;
 float weather=cloudPreset>.5?.83:smoothstep(.07,.90,texture2D(cloudMap,uv).r);
 if(weather<.035)return 0.;
 vec3 q=(normalize(p)*planetRadius+cloudWind(2.))*.065;
 float threshold=.52,strength=.5;
 if(cloudPreset<.5){threshold=.42;}
 else if(cloudPreset<1.5){q=(normalize(p)*planetRadius+cloudWind(10.))*vec3(.008,.14,.038);threshold=.48;strength=.12;}
 else if(cloudPreset<3.5){threshold=.30;strength=.14;}
 else if(cloudPreset<6.5||cloudPreset>7.5&&cloudPreset<8.5){q*=.2;threshold=.24;strength=.65;}
 float column=1.;
 if(cloudPreset>8.5&&cloudPreset<9.5)column=smoothstep(.52,.65,cloudNoise3((normalize(p)*planetRadius+cloudWind(2.))*.035).g);
 return weather*smoothstep(threshold-.06,threshold+.18,cloudNoise3(q).r)*strength*column;
}
float cloudShadow(vec3 p){
 if(cloudsEnabled<.5)return 1.;
 #ifdef EARTH_CLOUD_SHADOW_CACHE
 float cachedShadow=shadeCache(p);
 if(cachedShadow>=0.)return cachedShadow;
 #endif
 if(cloudPreset<-.5){
  float day=dot(normalize(p),sunDirection);
  if(day<.025)return 1.;
  float climate=cloudClimate(p),opticalDepth=0.;
  for(int i=0;i<3;i++){
   float height=(i==0?1.5:(i==1?4.5:9.5))*climate;
   if(length(p)>=planetRadius+height)continue;
   vec3 samplePoint=p+sunDirection*max(0.,sphereInterval(p,sunDirection,planetRadius+height).y);
   vec3 coverage=texture2D(cloudMap,earthUv(samplePoint)).rgb;
   float fraction=i==0?coverage.r:(i==1?coverage.g:coverage.b);
   if(fraction<.035)continue;
   float noise=cloudNoise3((normalize(samplePoint)*planetRadius+cloudWind(height))*(i==0?.065:.018)).r;
   opticalDepth+=smoothstep(.58-.32*fraction,.73-.32*fraction,noise)*fraction*(i==0?.55:(i==1?.38:.15));
  }
  return exp(-opticalDepth*smoothstep(.025,.2,day));
 }
 float height=cloudPreset<.5?4.:(cloudPreset<3.5?9.:(cloudPreset<6.5?4.5:(cloudPreset<9.5?1.8:9.)));
 height*=cloudClimate(p);
 if(length(p)>planetRadius+height)return 1.;
 float day=dot(normalize(p),sunDirection);if(day<.025)return 1.;
 vec2 hit=sphereInterval(p,sunDirection,planetRadius+height);
 return 1.-.45*cloudCover(p+sunDirection*max(0.,hit.y))*smoothstep(.025,.2,day);
}
`;
function create(THREE, map, sky, options = {}) {
    const lifetime = require("./lifetime").createLifetime();
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    black.needsUpdate = true;
    const volume = map.renderer.capabilities.isWebGL2 ? require("./cloud-volume") : undefined;
    const emptyVolume = volume?.texture3D(THREE,new Uint8Array(4),1);
    const uniforms = {
        nightMap: { value: black },
        nightDetailMap: { value: null },
        nightCenter: { value: new THREE.Vector2() },
        nightDetailFade: { value: 0 },
        cloudMap: { value: black },
        cloudsEnabled: { value: 1 },
        lightsEnabled: { value: 1 },
        buildingLightBlend: { value: 0 },
        cloudTime: { value: 0 },
        cloudNoise: { value: emptyVolume || black },
        cloudPreset: { value: 0 }
    };
    const status = {
        nightReady: false,
        nightPageRequests: 0,
        nightPage: undefined,
        cloudReady: false,
        noiseReady: false,
        errors: []
    };
    let historical, forecast, refineCoverage;
    const loader = require("./textures").createTextureLoader(THREE);
    const localLights =
        !options.nightMapUrl && map.renderer.capabilities.maxTextures >= 12
            ? createNightDetail(THREE, map, sky, loader, uniforms, status)
            : undefined;
    for (const [name, file, flag] of [
        ["nightMap", "night/global.webp", "nightReady"],
        ["cloudMap", options.orbitalCoverage ? "cloud-coverage-orbit.webp" : "cloud-coverage.webp", "cloudReady"],
        ["cloudNoise", "cloud-noise.webp", "noiseReady"]
    ]) {
        const customUrl = options[name + "Url"];
        const load = (url, fallback) =>
            loader.load(
                url,
                t => {
                    if (lifetime.disposed) {
                        t.dispose();
                        return;
                    }
                    if (name === "cloudNoise" && volume) {
                        try {
                            const atlas = t;
                            t = volume.fromAtlas(THREE,atlas.image);
                            atlas.dispose();
                        } catch {
                            t.dispose();
                            status.errors.push(file);
                            map.update();
                            return;
                        }
                    }
                    if (name !== "cloudNoise") scalarFormat(THREE, map.renderer, t);
                    if (!t.isData3DTexture) t.wrapS =
                        name === "cloudNoise" ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
                    t.minFilter =
                        name === "cloudNoise" ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
                    t.magFilter = THREE.LinearFilter;
                    // An atlas is indexed as data; flipping the whole image reorders
                    // slice rows and creates discontinuities every eight slices.
                    if (name === "cloudNoise") t.flipY = false;
                    t.generateMipmaps = name !== "cloudNoise";
                    if (name === "cloudMap") {
                        historical?.dispose();
                        historical = t;
                        if (options.orbitalCoverage && !customUrl && t.image.width < 2048)
                            refineCoverage = () => load("resources/earth/cloud-coverage.webp");
                    }
                    if (name !== "cloudMap" || !forecast?.active) uniforms[name].value = t;
                    status[flag] = true;
                    map.update();
                },
                undefined,
                () => {
                    if (lifetime.disposed) return;
                    if (fallback) {
                        load(fallback);
                        return;
                    }
                    status.errors.push(file);
                    map.update();
                },
                // Decode large scalar maps away from the first frame that samples
                // them. The slice atlas has its own unflipped row convention.
                { bitmap: name !== "cloudNoise", stallMs: 0 }
            );
        const loadRaster = () => load(
            customUrl || "resources/earth/" + file,
            name === "cloudNoise" && !customUrl ? "resources/earth/cloud-noise.png" :
                name === "cloudMap" && options.orbitalCoverage && !customUrl ?
                    "resources/earth/cloud-coverage.webp" : undefined
        );
        if (name === "cloudNoise" && volume && !customUrl) {
            volume.generate(THREE,lifetime,texture=>{
                uniforms.cloudNoise.value = texture;
                status.noiseReady = true;
                map.update();
            },loadRaster);
        } else loadRaster();
    }
    const cloudSystem = createClouds(THREE, map, sky, uniforms, glsl);
    if (options.forecast) forecast = require("./cloud-forecast").createForecast(THREE, map, uniforms, status, cloudSystem, () => historical, black);
    let last = performance.now(),
        elapsed = (options.initialTime || 0) * 1000,
        enabled = true;
    if (options.autonomousAnimation !== false)
        scheduleCloudWind(
            map,
            lifetime,
            () => enabled && uniforms.cloudsEnabled.value && status.cloudReady && status.noiseReady
        );
    return {
        dispose() {
            if (lifetime.disposed) return;
            lifetime.dispose();
            localLights?.dispose();
            loader.dispose();
            forecast?.dispose();
            cloudSystem.dispose();
            for (const name of ["nightMap", "cloudMap", "cloudNoise"])
                if (uniforms[name].value !== black && uniforms[name].value !== emptyVolume) uniforms[name].value.dispose();
            emptyVolume?.dispose();
            black.dispose();
        },
        uniforms,
        localLights: !!localLights,
        status,
        clouds: cloudSystem.mesh,
        cloudStats: cloudSystem.status,
        cloudPresets: cloudSystem.presets,
        setCloudPreset: forecast?.setPreset || cloudSystem.setPreset,
        setCloudQuality: cloudSystem.setQuality,
        setCloudBudget: cloudSystem.setBudget,
        update(mode, deltaSeconds) {
            if (lifetime.disposed) return;
            const now = performance.now();
            localLights?.update(mode, now);
            // A restored or user-zoomed blog orbit can resolve the full cloud
            // coverage. Keep its working overview on screen during the upgrade.
            if (refineCoverage && uniforms.cloudsEnabled.value && map.targetDistance > 0 &&
                map.targetDistance < 7000 * map.canvas.height && !globalThis.navigator?.connection?.saveData) {
                const load = refineCoverage;
                refineCoverage = undefined;
                load();
            }
            elapsed +=
                deltaSeconds === undefined
                    ? document.hidden
                        ? 0
                        : Math.min(250, now - last)
                    : Math.max(0, deltaSeconds) * 1000;
            last = now;
            uniforms.cloudTime.value = elapsed / 1000;
            enabled = mode === "a";
            cloudSystem.update(
                enabled &&
                    uniforms.cloudsEnabled.value > 0 &&
                    status.cloudReady &&
                    status.noiseReady
            );
        },
        setClouds(value) {
            uniforms.cloudsEnabled.value = value ? 1 : 0;
            map.update();
        },
        setLights(value) {
            uniforms.lightsEnabled.value = value ? 1 : 0;
            map.update();
        }
    };
}
module.exports = { create, glsl, scheduleCloudWind };
