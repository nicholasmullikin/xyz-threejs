const EarthAtmosphere = require("./atmosphere");
const EarthEnvironment = require("./environment");
const tileCoordinates = require("./building-coordinates");
const N = 2 ** 14;
function createStyle(THREE, map, sky, environment, getHeight, getSurfacePages, survey) {
    // The base plus up to four finer pages share the terrain cache. These
    // consume no network slots and hold a texture reference only during a draw.
    // WebGL 1 permits devices with no vertex texture fetch or only eight
    // varying vectors. Those devices retain the per-fragment atmosphere.
    const vertexAerial = map.renderer?.capabilities?.maxVertexTextures > 0 &&
        map.renderer.capabilities.maxVaryings >= 10;
    const roofSlots = getSurfacePages
        ? Math.min(
              5,
              Math.max(0, map.renderer.capabilities.maxTextures - (environment.localLights ? 6 : 5))
          )
        : 0;
    const slots = Array.from({ length: roofSlots }, (_, i) => i);
    function bindRoof(tile, material, mesh) {
        if ((!roofSlots && !vertexAerial) || mesh.userData.earthRoofBound) return;
        const u = material.uniforms;
        const before = mesh.onBeforeRender,
            after = mesh.onAfterRender;
        mesh.userData.earthRoofBound = true;
        mesh.onBeforeRender = function (...args) {
            before.apply(this, args);
            if (vertexAerial) {
                // A bounding sphere also bounds the longest triangle in this
                // batch. Keep large geometry on the exact per-fragment path.
                const radius = mesh.geometry.boundingSphere?.radius;
                u.aerialVertexAllowed.value = Number.isFinite(radius) && radius <= 1500 ? 1 : 0;
            }
            const pages = roofSlots ? getSurfacePages(tile.tileKey) : undefined;
            for (const i of slots) {
                const page = i === 0 ? pages.base : pages.details[i - 1];
                u["roofMap" + i].value = page?.texture ?? null;
                u["roofWeight" + i].value = page?.fade ?? 0;
                if (page) u["roofUv" + i].value.fromArray(page.uv);
            }
            material.uniformsNeedUpdate = true;
        };
        mesh.onAfterRender = function (...args) {
            for (const i of slots) u["roofMap" + i].value = null;
            after.apply(this, args);
        };
    }
    const foundations = new WeakMap();
    function updateFoundations(tile, geometry, version) {
        const uv = geometry.attributes.baseUv;
        if (!uv) return;
        let state = foundations.get(geometry);
        if (!state || state.uv !== uv) {
            // The worker emits each footprint's walls and roof consecutively.
            // Cache those runs, so each building takes one height query.
            const runs = [0];
            for (let i = 1; i < uv.count; i++) {
                if (uv.getX(i) !== uv.getX(i - 1) || uv.getY(i) !== uv.getY(i - 1)) runs.push(i);
            }
            runs.push(uv.count);
            const attribute = new THREE.BufferAttribute(
                new Uint16Array(uv.count),
                1,
                true
            ).setUsage(THREE.DynamicDrawUsage);
            geometry.setAttribute("foundationHeight", attribute);
            state = {
                uv,
                attribute,
                runs: Uint32Array.from(runs),
                baseSphere: geometry.boundingSphere.clone(),
                version: Symbol()
            };
            foundations.set(geometry, state);
        }
        const observations=survey?.roofSamples(tile.tileKey);
        if (state.version === version && state.lidarOwner===observations?.owner && state.lidarRevision===observations?.revision) return;
        state.lidarOwner=observations?.owner;
        state.lidarRevision=observations?.revision;
        state.version = version;
        let low = Infinity,
            high = -Infinity,
            first = uv.count,
            last = 0;
        const n = 2 ** tile.tileKey.level || N;
        for (let run = 0; run < state.runs.length - 1; run++) {
            const start = state.runs[run],
                end = state.runs[run + 1];
            if (start === end) continue;
            const x = (tile.tileKey.column + tileCoordinates.unpack(uv.getX(start))) / n,
                y = (tile.tileKey.row + tileCoordinates.unpack(uv.getY(start))) / n;
            const value = getHeight.atMercator
                ? getHeight.atMercator(x, y)
                : getHeight({
                      longitude: x * 360 - 180,
                      latitude: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI
                  });
            const height = Math.max(-1000, Math.min(9000, value));
            const packed = Math.round(((height + 1000) * 65535) / 10000);
            const previous=state.adjustments?.get(start)||0;
            const adjustment=observations ? require("./lidar-buildings").observedRoof(geometry,start,end,observations.sample,height,previous)||0 : 0;
            if(previous || adjustment){
                // Reuse the foundation displacement for roof vertices. The
                // corresponding facade coordinate keeps windows at metre scale.
                const wall=geometry.attributes.uv;
                const top=Math.round(((height+adjustment+1000)*65535)/10000);
                if(previous!==adjustment||state.attribute.array[start]!==top){
                    for(let i=start;i<end;i++){
                        const y=wall.getY(i);
                        state.attribute.array[i]=y===0?packed:top;
                        if(y>0 && previous!==adjustment)wall.setY(i,y+adjustment-previous);
                    }
                    if(previous!==adjustment)wall.needsUpdate=true;
                    first=Math.min(first,start);last=end;
                }
                if(adjustment){
                    state.adjustments??=new Map();
                    state.adjustments.set(start,adjustment);
                }else state.adjustments?.delete(start);
            }else if (state.attribute.array[start] !== packed) {
                state.attribute.array.fill(packed, start, end);
                first = Math.min(first, start);
                last = end;
            }
            low = Math.min(low, height,height+adjustment);
            high = Math.max(high, height,height+adjustment);
        }
        geometry.userData.measuredBuildings=state.adjustments?.size||0;
        if (last > first) {
            const range = state.attribute.updateRange;
            if (range.count > 0) {
                first = Math.min(first, range.offset);
                last = Math.max(last, range.offset + range.count);
            }
            range.offset = first;
            range.count = last - first;
            state.attribute.needsUpdate = true;
        }
        if (Number.isFinite(low)) {
            const bounds = geometry.boundingSphere.copy(state.baseSphere);
            bounds.center.addScaledVector(tile.center, (low + high) / (2 * tile.center.length()));
            bounds.radius += (high - low) / 2 + 2;
        }
    }
    const vertex = `#include <common>
#include <logdepthbuf_pars_vertex>
#ifdef EARTH_WATER_CAPTURE
uniform vec3 waterOrigin;
#endif
uniform vec3 cameraKm;uniform vec3 tileOrigin;attribute float foundationHeight;
attribute vec2 baseUv;attribute float seed;attribute vec2 tileUv;
varying vec2 footprintCenter;varying vec3 worldKm;varying vec3 worldNormal;varying vec3 tint;varying vec2 facadeUv;varying vec2 boundaryUv;varying float buildingSeed;
#if EARTH_VERTEX_AERIAL == 1
uniform float aerialVertexAllowed;
varying vec3 vertexHaze;varying vec3 vertexTransmission;
${EarthAtmosphere.glsl.replace("uniform vec3 cameraKm;", "")}
#endif
void main(){
 vec2 center=baseUv/${tileCoordinates.SCALE}.+0.5;
 footprintCenter=vec2(center.x,1.-center.y);
 float ground=foundationHeight*10000.-1000.;
 vec3 radial=normalize(tileOrigin+position);vec3 p=position+radial*(ground+.5);
 vec4 world=modelMatrix*vec4(p,1.);worldKm=world.xyz*.001;
 #ifdef EARTH_WATER_CAPTURE
 worldKm+=waterOrigin;
 #else
 worldKm+=cameraKm;
 #endif
 worldNormal=normal;tint=color;facadeUv=uv;boundaryUv=tileUv/${tileCoordinates.SCALE}.+0.5;buildingSeed=seed;
 #if EARTH_VERTEX_AERIAL == 1
 vertexHaze=vec3(0.);vertexTransmission=vec3(1.);
 if(aerialVertexAllowed>.5){
  vec3 airDelta=worldKm-cameraKm;float airDistance=length(airDelta);
  vertexHaze=aerialPerspective(cameraKm,airDelta/max(airDistance,.0001),airDistance,vertexTransmission);
 }
 #endif
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
 #include <logdepthbuf_vertex>
}`;
    const fragment = `precision highp float;
#include <logdepthbuf_pars_fragment>
#ifdef EARTH_WATER_CAPTURE
uniform vec3 waterOrigin,waterPlaneUp;
#endif
uniform float tileFade;
${slots.map(i => `uniform sampler2D roofMap${i};uniform vec4 roofUv${i};uniform float roofWeight${i};`).join("\n")}
varying vec2 footprintCenter;varying vec3 worldKm;varying vec3 worldNormal;varying vec3 tint;varying vec2 facadeUv;varying vec2 boundaryUv;varying float buildingSeed;
${EarthAtmosphere.glsl}
${EarthEnvironment.glsl}
${require("./local-shadows").glsl}
#if EARTH_VERTEX_AERIAL == 1
uniform float aerialVertexAllowed;
varying vec3 vertexHaze;varying vec3 vertexTransmission;
#endif
vec3 roofColor(vec3 fallback,sampler2D page,vec4 transform,float weight,float day){
 float width=facadeUv.x*transform.x;
 float fidelity=weight*smoothstep(1.2,4.,width);
 if(fidelity<=0.)return fallback;
 vec2 coord=vec2(boundaryUv.x,1.-boundaryUv.y);
 // Move a fraction of a texel toward the footprint so roof edges bleed less
 // into the adjacent road or lawn in an oblique photograph.
 coord=mix(coord,footprintCenter,min(.15,.65/max(width,1.)));
 vec2 uv=coord*transform.xy+transform.zw;
 vec2 edge=min(uv,vec2(1.)-uv);
 if(min(edge.x,edge.y)<0.)return fallback;
 return mix(fallback,photographicReflectance(pow(texture2D(page,uv).rgb,vec3(2.2)),day),fidelity);
}
${require("./facade-night").facadeLights}
void main(){
 #ifdef EARTH_WATER_CAPTURE
 if(dot((worldKm-waterOrigin)*1000.,waterPlaneUp)<1.5)discard;
 #endif
 if(any(lessThan(boundaryUv,vec2(0.)))||any(greaterThan(boundaryUv,vec2(1.))))discard;
 vec3 delta=worldKm-cameraKm;float distance=length(delta),fade=tileFade*(1.-smoothstep(8.,13.,distance));
 highp vec2 pixel=floor(gl_FragCoord.xy);
 if(fade<1. && fract(52.9829189*fract(dot(pixel,vec2(.06711056,.00583715))))>fade)discard;
 #include <logdepthbuf_fragment>
 vec3 radial=normalize(worldKm),normal=normalize(worldNormal);float day=dot(radial,sunDirection),diffuse=max(dot(normal,sunDirection),0.);
 vec3 direct=sunlight(worldKm)*cloudShadow(worldKm);
 #ifdef EARTH_SUN_SHADOW
 direct*=mix(.09,1.,groundSun(worldKm,normal));
 #endif
 vec3 albedo=pow(tint,vec3(2.2));float roof=facadeUv.y<0.?1.:0.;
 vec3 emission=vec3(0.);
 float family=mod(floor(buildingSeed*65535.+.5),4.);
 if(roof>.5){
  vec3 mappedTint=albedo;
  ${slots.map(i => `albedo=roofColor(albedo,roofMap${i},roofUv${i},roofWeight${i},day);`).join("\n")}
  // A near-vertical roof face occupies very few aerial texels. Preserve the
  // mapped roofing color as the photographic footprint becomes foreshortened.
  if(facadeUv.y< -1.5)albedo=mix(albedo,mappedTint,.28+.62*(1.-clamp(dot(radial,normal),0.,1.)));
 }else if(family>2.5){
  // Religious and structural parts often have solid masonry drums. Their
  // actual roof and wall geometry supplies the silhouette.
  albedo*=.85+.15*smoothstep(0.,5.,facadeUv.y);
 }else{
  // Keep the same windows in daylight and after sunset. Integrate panes
  // below pixel scale so they change smoothly with viewing distance.
  float curtain=step(1.5,family),masonry=step(.5,family)*(1.-curtain);
  float bay=mix(3.2+1.5*buildingSeed,1.35+.65*buildingSeed,curtain);
  vec2 cell=facadeUv/vec2(bay,mix(3.1,3.75,buildingSeed)),f=fract(cell),aa=max(fwidth(cell),vec2(.018));
  vec2 low=mix(vec2(.21,.27),vec2(.06,.10),curtain);
  vec2 high=mix(vec2(.74,.85),vec2(.94,.87),curtain);
  vec2 pane=smoothstep(low-aa,low+aa,f)*(1.-smoothstep(high-aa,high+aa,f));
  float resolved=1.-smoothstep(.27,.92,max(aa.x,aa.y));
  vec2 paneUv=(f-low)/(high-low),footprint=aa/(high-low);
  float paneMask=pane.x*pane.y*facadeSash(paneUv,footprint,curtain),glass=mix((high.x-low.x)*(high.y-low.y),paneMask,resolved);
  // Brick, stone and glass have different ratios of windows to solid wall.
  // Keep floor grouping stable as individual bays shrink below a pixel.
  float lintel=(1.-smoothstep(.025,.04+aa.y,abs(f.y-.92)))*resolved;
  albedo*=1.+.12*lintel*masonry;
  albedo*=mix(.76,1.,smoothstep(0.,5.,facadeUv.y));
  vec3 eye=normalize(-delta);
  float grazing=pow(1.-clamp(dot(normal,eye),0.,1.),4.);
  vec3 reflected=reflect(-eye,normal);
  float seesSky=smoothstep(-.12,.55,dot(reflected,radial));
  float sunlit=smoothstep(-.12,.17,day);
  vec3 ambientGlass=mix(vec3(.030,.034,.037),vec3(.075,.115,.165),seesSky);
  emission+=glass*ambientGlass*(.45+1.2*grazing)*sunlit;
  albedo=mix(albedo,albedo*.20+vec3(.012,.017,.021),glass);
  float darkness=nightWeight(worldKm)*lightsEnabled;
  if(darkness>0.){
   // Constant vertex attributes can acquire tiny interpolation errors. The
   // sine hash magnifies those into pixel noise unless the seed is restored
   // to the original 16-bit value before deriving per-window occupancy.
   float stableSeed=floor(buildingSeed*65535.+.5)/65535.;
   vec3 lamps=facadeLamps(cell,stableSeed,curtain,paneMask,(high.x-low.x)*(high.y-low.y),resolved,radial,sunDirection,paneUv,footprint);
   emission+=lamps*localLights(distance)*mix(.10,.41,smoothstep(.02,.6,citySignal(worldKm)))*darkness;
  }
 }
 vec3 lit=emission+albedo*(surfaceAmbient(radial,normal,day,vec3(.035,.048,.075)+vec3(.24,.29,.37)*smoothstep(-.12,.18,day))+direct*(.28+.72*diffuse)*smoothstep(-.03,.06,day));
 vec3 transmission;vec3 haze;
 #if EARTH_VERTEX_AERIAL == 1
 // On bounded building batches, interpolated atmosphere remains accurate
 // across city-scale distances; blend to the exact path farther away.
 if(aerialVertexAllowed>.5 && distance<8.){
  transmission=vertexTransmission;haze=vertexHaze;
  if(distance>7.5){
   vec3 exactTransmission;vec3 exactHaze=aerialPerspective(cameraKm,delta/max(distance,.0001),distance,exactTransmission);
   float blend=smoothstep(7.5,8.,distance);
   transmission=mix(transmission,exactTransmission,blend);haze=mix(haze,exactHaze,blend);
  }
 }else
 #endif
 {haze=aerialPerspective(cameraKm,delta/max(distance,.0001),distance,transmission);}
 #ifdef EARTH_WATER_CAPTURE
 vec3 reflectedLight=max(vec3(0.),lit*transmission+haze);
 gl_FragColor=vec4(sqrt(reflectedLight/(1.+reflectedLight)),.5+.5*clamp(log2(max(1.,1./gl_FragCoord.w))/13.,0.,1.));
 #else
 gl_FragColor=vec4(displayColor(lit*transmission+haze),1.);
 #endif
}`;

    return {
        create(tile) {
            const material = new THREE.ShaderMaterial({
                vertexShader: vertex,
                fragmentShader: fragment,
                vertexColors: true,
                extensions: { fragDepth: true, derivatives: true },
                defines: {
                    ATMOSPHERE_STEPS: 6,
                    EARTH_VERTEX_AERIAL: vertexAerial ? 1 : 0,
                    ...(environment.localLights ? { EARTH_LOCAL_LIGHTS: 1 } : {})
                },
                uniforms: {
                    ...sky.uniforms,
                    ...environment.uniforms,
                    tileOrigin: { value: tile.center.clone() },
                    tileFade: { value: 0 },
                    aerialVertexAllowed: { value: 0 }
                }
            });
            for (const i of slots) {
                material.uniforms["roofMap" + i] = { value: null };
                material.uniforms["roofUv" + i] = { value: new THREE.Vector4() };
                material.uniforms["roofWeight" + i] = { value: 0 };
            }
            material.userData.earthBuilding = {
                tile,
                start: performance.now()
            };
            return material;
        },
        update(tile, material, version, knownMesh) {
            const state = material.userData.earthBuilding;
            if (!state) return;
            const mesh =
                knownMesh ||
                tile.objects.find(o => o.material === material && o.isMesh) ||
                tile.objects.find(o => o.isMesh);
            if (mesh) bindRoof(tile, material, mesh);
            const geometry = mesh?.geometry;
            if (geometry) updateFoundations(tile, geometry, version);
            const fade =
                Math.min(1, (performance.now() - state.start) / 850) *
                Math.min(1, Math.max(0, (map.zoomLevel - 12.4) / 0.8));
            material.uniforms.tileFade.value = fade;
            if (performance.now() - state.start < 850) map.update();
        }
    };
}
module.exports = { createStyle };
