const EarthAtmosphere = require("./atmosphere");
const EarthEnvironment = require("./environment");
const N = 2 ** 14;
function createStyle(THREE, map, sky, environment, getHeight) {
    function heightTexture() {
        const data = new Uint8Array(8 * 8 * 4);
        const t = new THREE.DataTexture(data, 8, 8, THREE.RGBAFormat);
        t.minFilter = t.magFilter = THREE.LinearFilter;
        t.needsUpdate = true;
        return t;
    }
    function refreshHeight(entry) {
        const data = entry.height.image.data;
        let low = Infinity,
            high = -Infinity;
        for (let y = 0; y < 8; y++)
            for (let x = 0; x < 8; x++) {
                const longitude = ((entry.x + x / 7) / N) * 360 - 180,
                    latitude =
                        (Math.atan(Math.sinh(Math.PI * (1 - (2 * (entry.y + y / 7)) / N))) * 180) /
                        Math.PI;
                const h = Math.max(-1000, Math.min(9000, getHeight({ latitude, longitude }))),
                    packed = Math.round(((h + 1000) / 10000) * 65535),
                    i = (y * 8 + x) * 4;
                low = Math.min(low, h);
                high = Math.max(high, h);
                data[i] = packed >> 8;
                data[i + 1] = packed & 255;
                data[i + 3] = 255;
            }
        entry.height.needsUpdate = true;
        // The vertex shader lifts buildings onto the DEM. Include that displacement
        // in the CPU bounds so ordinary frustum culling remains valid on hills.
        const bounds = entry.mesh.geometry.boundingSphere;
        bounds.copy(entry.baseSphere);
        bounds.center.addScaledVector(entry.origin.clone().normalize(), (low + high) / 2);
        bounds.radius += (high - low) / 2 + 2;
    }
    const vertex = `#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 cameraKm;uniform vec3 tileOrigin;uniform sampler2D groundMap;
attribute vec2 baseUv;attribute float seed;attribute vec2 tileUv;
varying vec3 worldKm;varying vec3 worldNormal;varying vec3 tint;varying vec2 facadeUv;varying vec2 boundaryUv;varying float buildingSeed;
void main(){
 vec2 encodedHeight=texture2D(groundMap,clamp(baseUv,0.,1.)*vec2(7./8.)+vec2(.5/8.)).rg;
 float ground=(encodedHeight.r*65280.+encodedHeight.g*255.)/65535.*10000.-1000.;
 vec3 radial=normalize(tileOrigin+position);vec3 p=position+radial*(ground+.5);
 vec4 world=modelMatrix*vec4(p,1.);worldKm=world.xyz*.001+cameraKm;worldNormal=normal;tint=color;facadeUv=uv;boundaryUv=tileUv;buildingSeed=seed;
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
 #include <logdepthbuf_vertex>
}`;
    const fragment = `precision highp float;
#include <logdepthbuf_pars_fragment>
uniform float tileFade;
varying vec3 worldKm;varying vec3 worldNormal;varying vec3 tint;varying vec2 facadeUv;varying vec2 boundaryUv;varying float buildingSeed;
${EarthAtmosphere.glsl}
${EarthEnvironment.glsl}
float random(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
 if(any(lessThan(boundaryUv,vec2(0.)))||any(greaterThan(boundaryUv,vec2(1.))))discard;
 vec3 delta=worldKm-cameraKm;float distance=length(delta),fade=tileFade*(1.-smoothstep(8.,13.,distance));
 if(random(floor(gl_FragCoord.xy))>fade)discard;
 #include <logdepthbuf_fragment>
 vec3 radial=normalize(worldKm),normal=normalize(worldNormal);float day=dot(radial,sunDirection),diffuse=max(dot(normal,sunDirection),0.);
 vec3 direct=sunlight(worldKm)*cloudShadow(worldKm);
 vec3 albedo=pow(tint,vec3(2.2));float roof=facadeUv.y<0.?1.:0.;
 vec3 lit=albedo*(vec3(.035,.048,.075)+vec3(.24,.29,.37)*smoothstep(-.12,.18,day)+direct*(.28+.72*diffuse)*smoothstep(-.03,.06,day));
 // Stylized facade lights; these are illustrative, not measured window occupancy.
 vec2 cell=facadeUv/vec2(3.2,3.6),f=fract(cell),aa=max(fwidth(cell),vec2(.015));
 vec2 pane=smoothstep(vec2(.17)-aa,vec2(.17)+aa,f)*(1.-smoothstep(vec2(.78)-aa,vec2(.78)+aa,f));
 float resolved=1.-smoothstep(.3,1.,max(aa.x,aa.y));
 float pattern=pane.x*pane.y*step(.42,random(floor(cell)+buildingSeed*1000.));
 // Integrate subpixel windows instead of switching them off or letting them shimmer.
 float occupancy=.45+.55*random(vec2(buildingSeed*900.,18.));
 float windows=mix(.08,pattern,resolved)*(1.-roof)*occupancy;
 vec3 lamp=mix(vec3(1.,.58,.21),vec3(.66,.80,1.),step(.74,buildingSeed));
 lit+=lamp*windows*1.1*nightWeight(worldKm)*lightsEnabled;
 vec3 transmission;vec3 haze=atmosphere(cameraKm,delta/max(distance,.0001),distance,transmission);
 gl_FragColor=vec4(displayColor(lit*transmission+haze),1.);
}`;

    return {
        create(tile) {
            const height = heightTexture();
            const material = new THREE.ShaderMaterial({
                vertexShader: vertex,
                fragmentShader: fragment,
                vertexColors: true,
                extensions: { fragDepth: true, derivatives: true },
                defines: { ATMOSPHERE_STEPS: 6 },
                uniforms: {
                    ...sky.uniforms,
                    ...environment.uniforms,
                    tileOrigin: { value: tile.center.clone() },
                    groundMap: { value: height },
                    tileFade: { value: 0 }
                }
            });
            material.userData.earthBuilding = {
                tile,
                height,
                start: performance.now(),
                version: ""
            };
            material.addEventListener("dispose", () => height.dispose());
            return material;
        },
        update(tile, material, version) {
            const state = material.userData.earthBuilding;
            if (!state) return;
            const geometry = tile.objects.find(o => o.isMesh)?.geometry;
            if (geometry && state.version !== version) {
                const entry = {
                    x: tile.tileKey.column,
                    y: tile.tileKey.row,
                    height: state.height,
                    origin: tile.center,
                    mesh: { geometry },
                    baseSphere:
                        geometry.userData.baseSphere ||
                        (geometry.userData.baseSphere = geometry.boundingSphere.clone())
                };
                refreshHeight(entry);
                state.version = version;
            }
            const fade =
                Math.min(1, (performance.now() - state.start) / 850) *
                Math.min(1, Math.max(0, (map.zoomLevel - 12.4) / 0.8));
            material.uniforms.tileFade.value = fade;
            if (performance.now() - state.start < 850) map.update();
        }
    };
}
module.exports = { createStyle };
