// Apply wind and sky reflections only where both the DEM and the complete,
// native-resolution satellite image independently confirm featureless open sea.
const { SIZE, makeSlopes } = require("./ocean-spectrum");
const { glsl: atmosphere } = require("./atmosphere");
const { glsl: environment } = require("./environment");
const { coordinates: skyView } = require("./sky-view");
const MAX_DISTANCE = 36,
    MIN_DISTANCE = 2;

const fragment = `precision highp float;
#include <logdepthbuf_pars_fragment>
varying vec2 tileUv;
varying vec3 worldKm;
uniform sampler2D oceanSlope;
uniform vec3 oceanUv,oceanAlbedo;
uniform float oceanBandBlend,oceanRange;

${atmosphere}
${environment}
${skyView}
${require("./water-lighting").glsl}
${require("./water-reflections").planarSampling}
vec3 waveNormal(vec3 up){
 vec2 wave=tileUv*oceanUv.x+oceanUv.yz;
 vec2 shift=cloudTime*vec2(.011,.003);
 vec4 low=texture2D(oceanSlope,wave+shift),mid=texture2D(oceanSlope,wave*2.+shift*2.);
 vec2 coeff=(low.rg-.5)*.36+(mid.ba-.5)*.24;
 if(oceanBandBlend>.001){
  vec2 high=texture2D(oceanSlope,wave*4.+shift*4.).ba;
  coeff=mix(coeff,(mid.rg-.5)*.36+(high-.5)*.24,oceanBandBlend);
 }
 vec3 east=normalize(vec3(-up.y,up.x,0.));
 #ifdef EARTH_WATER_MODEL
 coeff*=sqrt(waterWind/.45);
 #endif
 #ifdef EARTH_WATER_BODY
 vec2 capillary=wave*19.+cloudTime*vec2(.043,-.019);
 float pixel=max(fwidth(capillary.x),fwidth(capillary.y));
 if(pixel<.18)coeff+=(texture2D(oceanSlope,capillary).ba-.5)*.17*sqrt(waterWind)*(1.-smoothstep(.035,.18,pixel));
 return normalize(up+east*coeff.x+cross(up,east)*coeff.y+waterSwell(worldKm,up,.055));
 #else
 return normalize(up+east*coeff.x+cross(up,east)*coeff.y);
 #endif
}
vec3 oceanLight(vec3 surface,vec3 up,vec3 view,vec3 direct,float day){
 vec3 n=waveNormal(up),r=reflect(-view,n),sky,unused;
 r=normalize(r+up*max(0.,.01-dot(r,up)));
 sampleSkyView(r,sky,unused);
 #ifdef EARTH_WATER_DEBUG
 return vec3(.04,.45,1.);
 #endif
 #ifdef EARTH_WATER_MODEL
 vec2 footprint=fwidth(tileUv*oceanUv.x)*128.;
 float unresolved=smoothstep(.4,2.,max(footprint.x,footprint.y));
 vec3 body=vec3(.0012,.0038,.0085)*(.015+smoothstep(-.12,.4,day));
 #ifdef EARTH_WATER_CLOUDS
 sky=reflectedClouds(sky,r,waterRoughness(unresolved,waterWind));
 #endif
 #ifdef EARTH_WATER_PLANAR
 sky=reflectedShore(sky,worldKm,r,waterWind);
 #endif
 return waterRadiance(body,sky,n,view,up,direct,day,unresolved,waterWind,vec2(1.));
 #else
 float nv=clamp(dot(view,n),.02,1.),nl=max(0.,dot(n,sunDirection));
 // Schlick Fresnel for air/water (IOR 1.333). Mips remove subpixel waves;
 // a finite GGX lobe retains their aggregate contribution to the sun glint.
 float fresnel=.0204+.9796*pow(1.-nv,5.);
 vec3 h=normalize(sunDirection+view);
 float nh=max(0.,dot(n,h)),vh=max(.001,dot(view,h));
 const float alpha=.155,alpha2=alpha*alpha,k=.5*alpha;
 float denom=nh*nh*(alpha2-1.)+1.;
 float distribution=alpha2/(3.14159*denom*denom);
 float visibility=.25/max(.001,mix(nv,1.,k)*mix(nl,1.,k));
 float glint=distribution*visibility*(.0204+.9796*pow(1.-vh,5.))*nl;
 vec3 deepWater=vec3(.0012,.0038,.0085)*(.015+smoothstep(-.12,.4,day));
 return mix(deepWater,sky*.58,fresnel)+direct*glint*.47*smoothstep(.0,.055,day);
 #endif
}
void main(){
 #include <logdepthbuf_fragment>
 vec3 up=normalize(worldKm),surface=up*planetRadius,delta=surface-cameraKm;
 float distance=length(delta),day=dot(up,sunDirection);
 vec3 dir=delta/max(.00001,distance),direct=sunlight(surface)*cloudShadow(surface);
 vec3 lit=photographicReflectance(oceanAlbedo,day)*(surfaceAmbient(up,up,day,vec3(.025)+vec3(.28,.34,.43)*smoothstep(-.12,.18,day))+direct*(.45+.55*max(0.,day))*smoothstep(-.03,.06,day));
 float weight=(1.-smoothstep(oceanRange*.45,oceanRange,distance))*smoothstep(0.,2.,oceanRange);

 if(weight>.001 && skyViewEnabled>.5) lit=mix(lit,oceanLight(surface,up,-dir,direct,day),weight);
 vec3 transfer,haze=aerialPerspective(cameraKm,dir,distance,transfer);
 gl_FragColor=vec4(displayColor(lit*transfer+haze),1.);
}`;

// Whole numbers of periods around Earth close at the date line. Blend two
// adjacent octaves with latitude to keep the physical wavelength consistent.
// Reducing the tile origin modulo 1 on the CPU preserves sub-metre precision.
function waveTransform(key, band, out) {
    const scale = 2 ** (18 + band - key.level);
    return out.set(scale, (key.column * scale) % 1, (-(key.row + 1) * scale) % 1);
}
function certifiedRange(visible, samples, camera) {
    let km = MAX_DISTANCE;
    for (const [tile, info] of visible) {
        if (info.water) continue;
        const bounds = tile.boundingBox;
        if (!bounds) return 0;
        km = Math.min(km, bounds.distanceToPoint(camera.position) * 0.001);
        if (km <= MIN_DISTANCE) return 0;
    }
    for (const s of samples) if (!visible.get(s.tile)?.water) km = Math.min(km, s.depth / 1600);
    return km > MIN_DISTANCE ? km : 0;
}

function createOcean(THREE, map, lifetime, ready) {
    let texture,
        building = false,
        range = 0,
        last = 0;
    function generate() {
        if (texture || building) return;
        building = true;
        const spectrum = makeSlopes();
        function advance() {
            const start = performance.now();
            do {
                const step = spectrum.next();
                if (!step.done) continue;
                texture = new THREE.DataTexture(step.value, SIZE, SIZE, THREE.RGBAFormat);
                texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
                texture.minFilter = THREE.LinearMipmapLinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.generateMipmaps = true;
                texture.needsUpdate = true;
                building = false;
                ready();
                return;
            } while (performance.now() - start < 2);
            lifetime.timeout(advance, 0);
        }
        lifetime.timeout(advance, 0);
    }
    lifetime.own(() => texture?.dispose());
    return function update(visible, samples, enabled, now, terrainShader, stats) {
        if (!enabled && !stats.oceanTiles) {
            range = 0;
            return;
        }
        stats.oceanTiles = 0;
        let wanted =
            enabled && map.zoomLevel >= 12 ? certifiedRange(visible, samples, map.camera) : 0;
        if (wanted && !texture) {
            generate();
            wanted = 0;
        }
        const dt = last ? Math.min(60, now - last) : 16;
        last = now;
        // Contract immediately at a coastline. Expand across newly confirmed
        // water over successive frames so fresh imagery never flashes.
        range = Math.min(wanted, range + (wanted - range) * Math.min(1, dt / 150));
        if (wanted - range > 0.05) stats.fading++;
        else range = wanted;
        const octave = Math.log2(Math.max(0.0625, Math.cos((map.target.latitude * Math.PI) / 180)));
        for (const [tile, info] of visible) {
            const state = info.state;
            if (!state) continue;
            const m = state.material;
            const water =
                info.water &&
                range > 0.01 &&
                tile.boundingBox.distanceToPoint(map.camera.position) < range * 1000;
            if (!water && !m.userData.openSea) continue;
            m.userData.openSea = !!water;
            const shader = water ? fragment : terrainShader;
            if (m.fragmentShader !== shader) {
                m.fragmentShader = shader;
                m.needsUpdate = true;
            }
            if (!water) continue;
            stats.oceanTiles++;
            const u = m.uniforms;
            if (!u.oceanSlope) {
                u.oceanSlope = { value: texture };
                u.oceanRange = { value: 0 };
                u.oceanUv = { value: new THREE.Vector3() };
                u.oceanBandBlend = { value: 0 };
                u.oceanAlbedo = { value: new THREE.Vector3() };
            }
            waveTransform(tile.tileKey, Math.floor(octave), u.oceanUv.value);
            u.oceanBandBlend.value = octave - Math.floor(octave);
            u.oceanRange.value = range;
            const from = state.from.entry.flatWater || info.water;
            const to = info.water,
                blend = state.mix;
            for (let i = 0; i < 3; i++)
                u.oceanAlbedo.value.setComponent(i, from[i] * (1 - blend) + to[i] * blend);
        }
    };
}
module.exports = { createOcean, certifiedRange, waveTransform };
