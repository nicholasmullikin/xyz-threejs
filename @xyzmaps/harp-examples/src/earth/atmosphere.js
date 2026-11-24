/* Spherical atmosphere, in kilometres. Apache-2.0.
 * References: Maxime Heckel, On Rendering the Sky, Sunsets, and Planets;
 * Bruneton/Neyret atmospheric transmittance, Rayleigh and Cornette-Shanks phases.
 * Build-time optical-depth LUT avoids a nested light raymarch in every sky fragment.
 */

const baked = require("./atmosphere-lut.json");
const multiple = require("./multiple-scattering.json");
const atlasHeight = baked.height + multiple.height;
const lunar = require("./lunar-albedo.json");
let lutData;
function makeLut(THREE) {
    // Shared immutable bytes; each renderer owns its own GPU texture.
    if (!lutData) {
        lutData = new Uint8Array(baked.width * atlasHeight * 4);
        lutData.set(Uint8Array.from(atob(baked.rgba), c => c.charCodeAt(0)));
        const extra = Uint8Array.from(atob(multiple.rgba), c => c.charCodeAt(0));
        for (let y = 0; y < multiple.height; y++)
            lutData.set(
                extra.subarray(y * multiple.width * 4, (y + 1) * multiple.width * 4),
                (baked.height + y) * baked.width * 4
            );
        // Two padded lunar strips occupy spare columns beside the 48×24
        // multiple-scattering table. The existing GPU allocation is sufficient.
        const values = Uint8Array.from(atob(lunar.data), v => v.charCodeAt(0));
        const half = lunar.height / 2;
        for (let bank = 0; bank < 2; bank++)
            for (let y = -1; y <= half; y++)
                for (let x = -1; x <= lunar.width; x++) {
                    const u = (x + lunar.width) % lunar.width,
                        v = Math.max(0, Math.min(lunar.height - 1, bank * half + y));
                    const col = multiple.width + bank * (lunar.width + 2) + 1 + x,
                        row = baked.height + 1 + y;
                    lutData[(row * baked.width + col) * 4] = values[v * lunar.width + u];
                }
    }
    const texture = new THREE.DataTexture(lutData, baked.width, atlasHeight, THREE.RGBAFormat);
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
}
const glsl = `
uniform sampler2D transmittanceLut;
uniform vec3 sunDirection;
uniform vec3 moonDirection;
uniform vec3 cameraKm;
const float planetRadius=6378.137;
const float atmosphereRadius=6478.137;
const vec3 betaR=vec3(.005802,.013558,.0331);
const vec3 betaO=vec3(.00065,.001881,.000085);
vec2 sphereInterval(vec3 origin,vec3 dir,float radius){
 // At the horizon, the two squared radii are about 4e7 km² and
 // their difference can represent only a few metres of camera altitude.
 float lengthOrigin=length(origin),c=(lengthOrigin-radius)*(lengthOrigin+radius);
 float b=dot(origin,dir),d=b*b-c;
 if(d<0.)return vec2(1e9,-1e9);
 float root=sqrt(d),farRoot=-b-(b>=0.?root:-root);
 if(abs(farRoot)<1e-8)return vec2(-b);
 float other=c/farRoot;return vec2(min(other,farRoot),max(other,farRoot));
}
vec2 airCoordinates(vec3 p){
 float r=length(p);
 return vec2(clamp(dot(p,sunDirection)/r*.5+.5,0.,1.),sqrt(clamp((r-planetRadius)/100.,0.,1.)));
}
vec3 directLight(vec2 uv){
 return texture2D(transmittanceLut,(uv*vec2(255.,63.)+.5)/vec2(256.,${atlasHeight}.)).rgb;
}
vec3 sunlight(vec3 p){return directLight(airCoordinates(p));}
vec3 scatteredLight(vec2 uv){
 vec3 encoded=texture2D(transmittanceLut,(uv*vec2(${multiple.width - 1}.,${multiple.height - 1}.)+vec2(.5,64.5))/vec2(256.,${atlasHeight}.)).rgb;
 return encoded*encoded;
}
vec3 densities(vec3 p){
 float h=max(length(p)-planetRadius,0.);
 return vec3(exp(-h/8.),exp(-h/1.2),max(0.,1.-abs(h-25.)/15.));
}
// Analytic integration of attenuation within each density sample. Replacing
// it with transmittance at the midpoint underestimates long, dense horizons.
vec3 scatterIntegral(vec3 tau, vec3 stepTrans){
 return mix(vec3(1.)-.5*tau,(1.-stepTrans)/max(tau,vec3(.0002)),step(vec3(.0002),tau));
}
vec3 integrateAir(vec3 origin,vec3 dir,float start,float end,int steps,out vec3 transmission){
 transmission=vec3(1.);
 if(end<=start)return vec3(0.);
 float mu=dot(dir,sunDirection),g=.8;
 float phaseR=3./(16.*3.14159265)*(1.+mu*mu);
 float phaseM=3.*(1.-g*g)*(1.+mu*mu)/(8.*3.14159265*(2.+g*g)*pow(max(.001,1.+g*g-2.*g*mu),1.5));
 vec3 scatter=vec3(0.);
 bool nearDense=length(origin+dir*start)<length(origin+dir*end);
 for(int i=0;i<ATMOSPHERE_STEPS;i++){
  if(i>=steps)break;
  float a=float(i)/float(steps),b=float(i+1)/float(steps);
  float sa=nearDense?a*a:1.-(1.-a)*(1.-a),sb=nearDense?b*b:1.-(1.-b)*(1.-b);
  float ta=start+(end-start)*sa,tb=start+(end-start)*sb;
  float stepSize=tb-ta;
  vec3 p=origin+dir*((ta+tb)*.5),density=densities(p);
  vec3 tau=(betaR*density.x+vec3(.00444)*density.y+betaO*density.z)*stepSize;
  vec3 stepTrans=exp(-tau);
  vec2 airUv=airCoordinates(p);
  vec3 phaseSource=directLight(airUv)*(density.x*betaR*phaseR+density.y*vec3(.003996)*phaseM);
  phaseSource+=scatteredLight(airUv)*(density.x*betaR+density.y*vec3(.003996));
  scatter+=transmission*scatterIntegral(tau,stepTrans)*phaseSource*stepSize;
  transmission*=stepTrans;
 }
 return scatter*8.;
}
vec3 atmosphere(vec3 origin,vec3 dir,float limit,out vec3 transmission){
 vec2 interval=sphereInterval(origin,dir,atmosphereRadius);
 return integrateAir(origin,dir,max(0.,interval.x),min(limit,interval.y),ATMOSPHERE_STEPS,transmission);
}
// Night-exposed diffuse illumination. The lunar term follows the apparent
// phase, rises only above the local horizon, and lights the facing slope.
vec3 surfaceAmbient(vec3 up,vec3 normal,float day,vec3 daylight){
 float dark=1.-smoothstep(-.14,-.025,day);
 if(dark<=0.)return daylight;
 float altitude=dot(up,moonDirection),cosPhase=dot(moonDirection,sunDirection);
 float illuminated=clamp(.5-.5*cosPhase,0.,1.);
 float moon=illuminated*illuminated*smoothstep(-.012,.12,altitude);
 vec3 night=vec3(.008,.011,.017)+moon*(.013+.091*max(0.,dot(moonDirection,normal)))*vec3(.82,.92,1.);
 return mix(daylight,night,dark);
}
vec3 aerialPerspective(vec3 origin,vec3 dir,float distance,out vec3 transmission){
 // Below the top of the atmosphere the camera-to-surface segment needs
 // no sphere intersection. Increase samples with path length and relief.
 float heightChange=distance*abs(dot(normalize(origin+dir*(distance*.5)),dir));
 if(distance<20. && heightChange<.8) return integrateAir(origin,dir,0.,distance,1,transmission);
 if(distance<40. && heightChange<2.) return integrateAir(origin,dir,0.,distance,2,transmission);
 if(distance<100. && heightChange<4.) return integrateAir(origin,dir,0.,distance,4,transmission);
 return atmosphere(origin,dir,distance,transmission);
}
// Satellite photographs are already display-referred. Undo our filmic curve
// before relighting so a unit-lit photo round-trips through displayColor.
vec3 photographicRadiance(vec3 displayLinear){
 vec3 a=max(vec3(.001),2.51-2.43*displayLinear),b=.03-.59*displayLinear;
 return (sqrt(b*b+.56*a*displayLinear)-b)/(2.*a);
}
// Inverting a display curve per channel turns tiny tints in clipped snow
// into huge differences in radiance. Under moonlight the photo supplies
// diffuse reflectance; reserve the inverse display transform for daylight.
vec3 photographicReflectance(vec3 linearPhoto,float sunElevation){
 vec3 reflectance=clamp(linearPhoto,0.,1.);
 float daylight=smoothstep(-.10,.12,sunElevation);
 if(daylight<=0.)return reflectance;
 vec3 radiance=photographicRadiance(reflectance);
 // The inverse curve becomes steep near white. In bright, pale highlights
 // recover the exposure using a shared gain, keeping the source channel ratios.
 float low=min(reflectance.r,min(reflectance.g,reflectance.b));
 float high=max(reflectance.r,max(reflectance.g,reflectance.b));
 float shoulder=smoothstep(.65,.92,low);
 radiance=mix(radiance,reflectance*(max(radiance.r,max(radiance.g,radiance.b))/max(high,.001)),shoulder);
 return mix(reflectance,radiance,daylight);
}
vec3 displayColor(vec3 color){
 color=max(color,vec3(0.));
 // Fitted filmic response, followed by exactly one linear-to-display conversion.
 color=clamp((color*(2.51*color+.03))/(color*(2.43*color+.59)+.14),0.,1.);
 return pow(color,vec3(1./2.2));
}
`;
function create(THREE, map, options = {}) {
    const { ephemeris, direction } = require("./ephemeris");
    const lunarCenter = new THREE.Vector3();
    const uniforms = {
        ...(options.orbitWater ? {globalWaterMask:{value:null},globalWaterStrength:{value:0}} : {}),
        oceanReliefWeight: { value: 0 },
        ...(options.surfaceFallback
            ? {
                  fallbackSurface: { value: null },
                  fallbackPreview: { value: null },
                  fallbackPage: { value: new THREE.Vector4() },
                  fallbackLights: { value: null },
                  fallbackLightStrength: { value: 0 }
              }
            : {}),
        sunRadius: { value: 0.00465 },
        moonRadius: { value: 0.00452 },
        lunarFrame: { value: new THREE.Matrix3() },
        siderealTurns: { value: 0 },
        moonDirection: { value: new THREE.Vector3() },
        transmittanceLut: { value: makeLut(THREE) },
        sunDirection: { value: new THREE.Vector3() },
        starAtlas: { value: null },
        useStarAtlas: { value: 0 },
        cameraKm: { value: new THREE.Vector3() },
        inverseProjection: { value: new THREE.Matrix4() },
        cameraRotation: { value: new THREE.Matrix3() }
    };
    const cache = options.orbitalCache
        ? require("./atmosphere-cache").createCache(THREE, map, uniforms, glsl)
        : undefined;
    const skyView = options.surfaceFallback
        ? require("./sky-view").createSkyView(THREE, map, uniforms, glsl)
        : undefined;
    const aerial =
        skyView && map.renderer.capabilities.maxTextures >= 16
            ? require("./aerial-view").create(THREE, map, uniforms, glsl)
            : undefined;
    const material = new THREE.ShaderMaterial({
        uniforms,
        extensions: { derivatives: true, shaderTextureLOD: true },
        depthTest: true,
        depthWrite: false,
        defines: {
            ...(options.orbitWater ? {EARTH_WATER_ORBIT:1} : {}),
            ATMOSPHERE_STEPS: 24,
            ...(options.surfaceFallback ? { EARTH_SURFACE_FALLBACK: 1 } : {})
        },
        vertexShader: `varying vec2 ndc;void main(){ndc=position.xy;gl_Position=vec4(position.xy,1.,1.);}`,
        fragmentShader: `precision highp float;varying vec2 ndc;uniform mat4 inverseProjection;uniform mat3 cameraRotation;uniform float sunRadius,moonRadius,siderealTurns;uniform mat3 lunarFrame;uniform sampler2D starAtlas;uniform float useStarAtlas;${glsl}
 ${require("./panorama-sampling").glsl}

 #ifdef EARTH_SURFACE_FALLBACK
 ${options.surfaceFallback ? require("./sky-view").coordinates : ""}
 ${options.surfaceFallback ? require("./ocean-relief").glsl : ""}
 ${require("./water-orbit").glsl}
 uniform sampler2D fallbackSurface, fallbackLights, fallbackPreview;
 uniform vec4 fallbackPage;
 uniform float fallbackLightStrength;
 #endif
 void main(){vec4 p=inverseProjection*vec4(ndc,1.,1.);vec3 dir=normalize(cameraRotation*p.xyz);
 vec2 ground=sphereInterval(cameraKm,dir,planetRadius);float end=ground.x>0.?ground.x:1e8;
 vec3 trans,color;
 // A miss returns (+infinity,-infinity); a forward intersection has two positive roots.
 bool hitsSurface=ground.x>0. && ground.y>=ground.x;
 #ifdef EARTH_SURFACE_FALLBACK
 if(skyViewEnabled>.5 && !hitsSurface)sampleSkyView(dir,color,trans);else
 #endif
 color=atmosphere(cameraKm,dir,end,trans);
 #ifdef EARTH_SURFACE_FALLBACK
 // This pass runs at cleared depth after real terrain. Fill only uncovered
 // rays at sea level, including the polar caps, at the correct horizon.
 if(hitsSurface){
  vec3 point=cameraKm+dir*ground.x,up=normalize(point);
  vec2 uv=vec2(atan(up.y,up.x)/6.283185307+.5,asin(clamp(up.z,-1.,1.))/3.141592654+.5);
  vec3 albedo=pow(samplePanorama(fallbackSurface,uv).rgb,vec3(2.2));
  if(fallbackPage.w>0. && abs(up.z)<.99627208){
   float row=.5-log((1.+up.z)/(1.-up.z))*.07957747155;
   vec2 pageUv=vec2(fract(uv.x)*fallbackPage.x-fallbackPage.y,1.+fallbackPage.z-row*fallbackPage.x);
   vec2 edge=min(pageUv,1.-pageUv);
   float blend=fallbackPage.w*smoothstep(0.,.03,min(edge.x,edge.y));
   if(blend>0.)albedo=mix(albedo,pow(texture2D(fallbackPreview,pageUv).rgb,vec3(2.2)),blend);
  }
  float day=dot(up,sunDirection);
  albedo=photographicReflectance(oceanCartography(albedo,fallbackSurface,uv),day);
  vec3 lit=albedo*(surfaceAmbient(up,up,day,vec3(.025)+vec3(.28,.34,.43)*smoothstep(-.12,.18,day))+
      sunlight(point)*(.45+.55*max(day,0.))*smoothstep(-.03,.06,day));
  #ifdef EARTH_WATER_ORBIT
  lit+=orbitalGlint(up,-dir,uv,sunlight(point));
  #endif
  float night=1.-smoothstep(-.12,.025,day);
  if(night*fallbackLightStrength>0.)lit+=vec3(1.,.64,.27)*pow(max(0.,samplePanorama(fallbackLights,uv).r-.035),1.65)*2.7*night*fallbackLightStrength;
  color+=lit*trans;
 }
 #endif
 if(!hitsSurface){
  float angle=atan(length(cross(dir,sunDirection)),dot(dir,sunDirection));
  float disc=1.-smoothstep(sunRadius*.978,sunRadius*1.022,angle);
  vec2 uv=vec2(fract(atan(dir.y,dir.x)/6.2831853+.5+siderealTurns),asin(clamp(dir.z,-1.,1.))/3.14159265+.5);
  vec2 grid=uv*vec2(2048.,1024.);
  float h=fract(sin(dot(floor(grid),vec2(12.9898,78.233)))*43758.5453);
  vec3 star=useStarAtlas>.5?samplePanorama(starAtlas,uv).rgb:vec3(step(.998,h)*(1.-smoothstep(.05,.5,length(fract(grid)-.5))));
  vec3 moonDir=moonDirection;
  vec3 lunarRay=(dir-moonDir)/moonRadius;float r2=dot(lunarRay,lunarRay);
  float moon=dot(dir,moonDir)>0.?1.-smoothstep(.92,1.,r2):0.;
  vec3 normal=normalize(lunarRay-moonDir*sqrt(max(0.,1.-r2)));
  float darkness=1.-smoothstep(.002,.08,dot(color,vec3(.21,.72,.07)));
  color+=trans*vec3((disc*14.+star*.38*darkness)*(1.-moon));
  if(moon>0.){
   vec3 local=lunarFrame*normal;
   vec2 uv=vec2(atan(local.y,local.x)/6.2831853+.5,asin(clamp(local.z,-1.,1.))/3.14159265+.5);
   float bank=step(.5,uv.y);
   vec2 texel=uv*vec2(80.,44.)+vec2(49.+bank*82.,65.-bank*22.);
   float maria=2.*texture2D(transmittanceLut,texel/vec2(256.,${atlasHeight}.)).r;
   float incidence=max(0.,dot(normal,sunDirection)),view=max(.001,-dot(normal,dir));
   // Lommel-Seeliger scattering keeps the full Moon's limb bright and
   // permits a much darker terminator on a crescent.
   float diffuse=incidence*(.30+1.40/(incidence+view+.0001));
   color+=trans*moon*maria*vec3(.56,.54,.49)*(.018+diffuse);
  }
 }
 // gl_FragCoord may be mediump in WebGL. Keep the hash intermediates
 // bounded even on large framebuffers; NaN here turns daylight pixels black.
 highp vec2 pixel=floor(gl_FragCoord.xy);
 float noise=fract(52.9829189*fract(dot(pixel,vec2(.06711056,.00583715))))-.5;
 gl_FragColor=vec4(displayColor(color)+noise/255.,1.);}`
    });
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    sky.frustumCulled = false;
    sky.renderOrder = 10000;
    map.scene.add(sky);
    let disposed = false;
    let starRequest,
        starRetry = 0,
        starEligibleSince,
        starWake;
    function requestStars() {
        if (
            options.orbitalCache ||
            starRequest ||
            uniforms.starAtlas.value ||
            performance.now() < starRetry
        )
            return;
        const position = uniforms.cameraKm.value;
        const radius = position.length();
        if (radius < 6628.137 && position.dot(uniforms.sunDirection.value) > 0.01 * radius) {
            starEligibleSince = undefined;
            clearTimeout(starWake);
            return;
        }
        const now = performance.now();
        if (starEligibleSince === undefined) {
            starEligibleSince = now;
            starWake = setTimeout(() => map.update(), 550);
        }
        if (now - starEligibleSince < 500) return;
        starRequest = new AbortController();
        require("./star-atlas")
            .createStarAtlas(THREE, starRequest.signal)
            .then(texture => {
                if (disposed) return texture.dispose();
                uniforms.starAtlas.value = texture;
                uniforms.useStarAtlas.value = 1;
                map.update();
            })
            .catch(() => {
                starRetry = performance.now() + 60000;
            })
            .finally(() => {
                starRequest = undefined;
            });
    }
    function setTime(utc) {
        const frame = ephemeris(utc);
        direction(uniforms.sunDirection.value, frame.sun, frame.sidereal);
        direction(lunarCenter, frame.moon, frame.sidereal).multiplyScalar(frame.moon.distance);
        require("./lunar-orientation").lunarOrientation(
            utc,
            frame.sidereal,
            uniforms.lunarFrame.value
        );
        uniforms.sunRadius.value = frame.sun.radius;
        uniforms.siderealTurns.value = frame.sidereal / (2 * Math.PI);
    }
    setTime(Date.now());
    function update() {
        uniforms.cameraKm.value.copy(map.camera.position).multiplyScalar(0.001);
        // Apply parallax at the actual observer, from sea level through orbit.
        const direction = uniforms.moonDirection.value
            .copy(lunarCenter)
            .sub(uniforms.cameraKm.value);
        const distance = Math.max(1737.5, direction.length());
        direction.multiplyScalar(1 / distance);
        uniforms.moonRadius.value = Math.asin(1737.4 / distance);
        uniforms.inverseProjection.value.copy(map.camera.projectionMatrixInverse);
        uniforms.cameraRotation.value.setFromMatrix4(map.camera.matrixWorld);
        requestStars();
        cache?.update();
        skyView?.update();
        aerial?.update();
    }
    return {
        uniforms,
        cache,
        aerial,
        setTime,
        update,
        sky,
        dispose() {
            disposed = true;
            clearTimeout(starWake);
            starRequest?.abort();
            uniforms.starAtlas.value?.dispose();
            cache?.dispose();
            skyView?.dispose();
            aerial?.dispose();
            map.scene.remove(sky);
            sky.geometry.dispose();
            material.dispose();
            uniforms.transmittanceLut.value.dispose();
        }
    };
}
module.exports = { create, glsl, makeLut };
