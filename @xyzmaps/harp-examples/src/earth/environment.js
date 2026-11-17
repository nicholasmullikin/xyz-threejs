const { noiseGLSL } = require("./cloud-model");
const { createClouds } = require("./clouds");
/* NASA Black Marble emission and procedural volumetric clouds.
 * Historical imagery with illustrative wind, not a live weather forecast.
 */

const glsl = `
uniform sampler2D nightMap;
uniform sampler2D cloudMap;
uniform float cloudsEnabled;
uniform float lightsEnabled;
uniform float cloudTime;
vec2 earthUv(vec3 p){vec3 n=normalize(p);return vec2(atan(n.y,n.x)/6.283185307+.5,asin(clamp(n.z,-1.,1.))/3.141592654+.5);}
float nightWeight(vec3 p){return 1.-smoothstep(-.12,.025,dot(normalize(p),sunDirection));}
vec3 nightEmission(vec3 p){float signal=texture2D(nightMap,earthUv(p)).r;return vec3(1.,.64,.27)*pow(max(0.,signal-.035),1.65)*2.7*nightWeight(p)*lightsEnabled;}
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
 float height=cloudPreset<.5?4.:(cloudPreset<3.5?9.:(cloudPreset<6.5?4.5:(cloudPreset<9.5?1.8:9.)));
 height*=cloudClimate(p);
 if(length(p)>planetRadius+height)return 1.;
 float day=dot(normalize(p),sunDirection);if(day<.025)return 1.;
 vec2 hit=sphereInterval(p,sunDirection,planetRadius+height);
 return 1.-cloudCover(p+sunDirection*max(0.,hit.y))*smoothstep(.025,.2,day);
}
`;
function create(THREE, map, sky) {
    const lifetime = require("./lifetime").createLifetime();
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    black.needsUpdate = true;
    const uniforms = {
        nightMap: { value: black },
        cloudMap: { value: black },
        cloudsEnabled: { value: 1 },
        lightsEnabled: { value: 1 },
        cloudTime: { value: 0 },
        cloudNoise: { value: black },
        cloudPreset: { value: 0 }
    };
    const status = { nightReady: false, cloudReady: false, noiseReady: false, errors: [] };
    const loader = require("./textures").createTextureLoader(THREE);
    for (const [name, file, flag] of [
        ["nightMap", "night-lights.jpg", "nightReady"],
        ["cloudMap", "clouds.jpg", "cloudReady"],
        ["cloudNoise", "cloud-noise.png", "noiseReady"]
    ])
        loader.load(
            "resources/earth/" + file,
            t => {
                if (lifetime.disposed) {
                    t.dispose();
                    return;
                }
                t.wrapS = name === "cloudNoise" ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
                t.minFilter =
                    name === "cloudNoise" ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
                t.magFilter = THREE.LinearFilter;
                // An atlas is indexed as data; flipping the whole image reorders
                // slice rows and creates discontinuities every eight slices.
                if (name === "cloudNoise") t.flipY = false;
                t.generateMipmaps = name !== "cloudNoise";
                uniforms[name].value = t;
                status[flag] = true;
                map.update();
            },
            undefined,
            () => {
                if (lifetime.disposed) return;
                status.errors.push(file);
                map.update();
            }
        );
    const cloudSystem = createClouds(THREE, map, sky, uniforms, glsl);
    let last = performance.now(),
        elapsed = 0,
        enabled = true;
    // Request at most 20 frames/sec when wind is the only animation; stop in hidden tabs.
    lifetime.interval(() => {
        if (
            enabled &&
            uniforms.cloudsEnabled.value &&
            status.cloudReady &&
            status.noiseReady &&
            !document.hidden
        )
            map.update();
    }, 50);
    return {
        dispose() {
            if (lifetime.disposed) return;
            lifetime.dispose();
            loader.dispose();
            cloudSystem.dispose();
            for (const name of ["nightMap", "cloudMap", "cloudNoise"])
                if (uniforms[name].value !== black) uniforms[name].value.dispose();
            black.dispose();
        },
        uniforms,
        status,
        clouds: cloudSystem.mesh,
        cloudStats: cloudSystem.status,
        cloudPresets: cloudSystem.presets,
        setCloudPreset: cloudSystem.setPreset,
        setCloudQuality: cloudSystem.setQuality,
        update(mode) {
            if (lifetime.disposed) return;
            const now = performance.now();
            elapsed += document.hidden ? 0 : Math.min(100, now - last);
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
module.exports = { create, glsl };
