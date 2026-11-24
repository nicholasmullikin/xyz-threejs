const EarthAtmosphere = require("./atmosphere");
const EarthEnvironment = require("./environment");
// WebGL 1 requires statically indexed samplers. Unused slots compile out on
// devices with fewer texture units, and the orbital material uses none.
const DETAIL_SLOTS = 8;
const detailDeclarations = Array.from(
    { length: DETAIL_SLOTS },
    (_, i) => `
#if EARTH_DETAIL_SLOTS > ${i}
#if defined(EARTH_SHARED_OVERVIEW) && ${i} == 0
#define detailMap0 earthMap
#else
uniform sampler2D detailMap${i};
#endif
uniform vec4 detailUv${i};
uniform float detailFade${i};
uniform vec4 detailEdges${i};
#endif`
).join("\n");
const detailSampling = Array.from(
    { length: DETAIL_SLOTS },
    (_, i) => `
#if EARTH_DETAIL_SLOTS > ${i}
if(detailFade${i}>0.) albedo=applyDetail(albedo,detailMap${i},detailUv${i},detailFade${i},detailEdges${i});
#endif`
).join("\n");
const vertex = `#include <common>
 #include <logdepthbuf_pars_vertex>
 uniform vec3 cameraKm;varying vec2 tileUv;varying vec3 worldKm;varying vec3 worldNormal;varying float surfaceAltitude;
 #ifndef EARTH_ORBITAL
 attribute float terrainSourceOffset;attribute vec3 terrainSourceNormal;
 uniform float terrainSourceScale;uniform float terrainNormalMix;
 #endif
 void main(){tileUv=uv;vec3 local=position;vec3 shadingNormal=normal;
 #ifndef EARTH_ORBITAL
 local.z+=terrainSourceOffset*terrainSourceScale;
 shadingNormal+=terrainSourceNormal*terrainNormalMix;
 #endif
 vec4 world=modelMatrix*vec4(local,1.);worldKm=world.xyz*.001+cameraKm;worldNormal=mat3(modelMatrix)*shadingNormal;surfaceAltitude=length(worldKm)-6378.137;gl_Position=projectionMatrix*modelViewMatrix*vec4(local,1.);
 #include <logdepthbuf_vertex>
 }`;
const fragment = `precision highp float;
 #include <logdepthbuf_pars_fragment>
 uniform float overlayMode;uniform float contoursEnabled;uniform float hillshadeStrength;uniform sampler2D parentMap;uniform vec4 parentUv;uniform float parentBase;uniform vec4 edgeMask;uniform sampler2D fromMap;uniform sampler2D toMap;uniform sampler2D earthMap;uniform vec4 fromUv;uniform vec4 toUv;uniform float fromBase;uniform float toBase;uniform float blend;
 varying vec2 tileUv;varying vec3 worldKm;varying vec3 worldNormal;varying float surfaceAltitude;
 #ifdef EARTH_STYLIZED_ROADS
 uniform sampler2D roadAtlas;uniform vec4 roadUv;
 #endif
 ${EarthAtmosphere.glsl}
 #ifdef EARTH_AERIAL_ATLAS
 ${require("./aerial-view").coordinates}
 #define EARTH_CLOUD_SHADOW_CACHE
 ${require("./cloud-shadow-cache").coordinates}
 #endif
 #ifdef EARTH_ATMOSPHERE_CACHE
 ${require("./atmosphere-cache").sampleGLSL}
 #endif
 ${EarthEnvironment.glsl}
 #if defined(EARTH_MAPPED_WATER) && defined(EARTH_AERIAL_ATLAS)
 ${require("./water-lighting").glsl}
 ${require("./water-reflections").planarSampling}
 uniform sampler2D mappedWater;
 uniform vec4 waterUv;uniform vec2 waterPhase;uniform float waveDetail;uniform vec4 waterFades[4];
 vec2 mappedSlopes(vec2 p,float plane){
   vec2 at=fract(p)*128.+vec2(1.,1025.);
   vec2 texel=vec2(1./1024.,1./1154.);
   at.x+=plane*130.;
   vec2 q=at*texel;
   return vec2(texture2D(mappedWater,q).r,texture2D(mappedWater,q+vec2(130./1024.,0.)).r)-.5;
 }
 vec3 waterLight(vec3 lit,vec3 up,vec3 direct,float day,float night){
   if(aerialViewEnabled<.5)return lit;
   vec2 uv=tileUv*waterUv.xy+waterUv.zw,edge=min(uv,1.-uv);
   if(min(edge.x,edge.y)<=0.)return lit;
   vec2 cell=floor(uv*4.);
   vec4 row=cell.y<1.?waterFades[0]:cell.y<2.?waterFades[1]:cell.y<3.?waterFades[2]:waterFades[3];
   float fade=cell.x<1.?row.x:cell.x<2.?row.y:cell.x<3.?row.z:row.w;
   float mask=texture2D(mappedWater,uv*vec2(1.,1024./1154.)).r*fade*smoothstep(0.,.025,min(edge.x,edge.y));
   if(mask<.003)return lit;
   #ifdef EARTH_WATER_DEBUG
   return mix(lit,vec3(.04,.85,.28),mask);
   #endif
   vec2 p=(uv+waterPhase)*128.,motion=cloudTime*vec2(.008,.004);
   float footprint=max(fwidth(p.x),fwidth(p.y));
   vec2 slope=vec2(0.);
   if(waveDetail>.5 && footprint<.22){
    slope=.13*mappedSlopes(p+motion,0.)*(1.-smoothstep(.055,.22,footprint));
    if(footprint<.09)slope+=.082*mappedSlopes(3.*p+motion*1.7,2.)*(1.-smoothstep(.018,.09,footprint));
   }
   vec3 east=normalize(vec3(-up.y,up.x,0.)),north=cross(up,east);
   #ifdef EARTH_WATER_MODEL
   float localWind=waterWind;
   #ifdef EARTH_WATER_BODY
   vec2 fetchUv=(vec2(520.5,1025.5)+clamp(uv,0.,1.)*127.)/vec2(1024.,1154.);
   float fetch=texture2D(mappedWater,fetchUv).r;
   localWind*=mix(.13,1.,smoothstep(0.,1.,fetch));
   #endif
   slope*=sqrt(localWind/.45);
   #endif
   #ifdef EARTH_WATER_BODY
   if(waveDetail>.5 && footprint<.015)
     slope+=mappedSlopes(p*13.+cloudTime*vec2(.031,-.022),2.)*.085*sqrt(localWind)*(1.-smoothstep(.003,.015,footprint));
   vec3 n=normalize(up+slope.x*east+slope.y*north+waterSwell(worldKm,up,.018*sqrt(localWind/max(.001,waterWind))));
   #else
   vec3 n=normalize(up+slope.x*east+slope.y*north);
   #endif
   vec3 view=normalize(cameraKm-worldKm),r=reflect(-view,n);
   vec3 trans,sky=cachedAerial(normalize(r+up*max(0.,.015-dot(r,up))),185.,trans);
   #ifdef EARTH_WATER_MODEL
   #ifdef EARTH_WATER_CLOUDS
   sky=reflectedClouds(sky,r,waterRoughness(smoothstep(.025,.22,footprint),localWind));
   #endif
   #ifdef EARTH_WATER_PLANAR
   sky=reflectedShore(sky,worldKm,r,localWind);
   #endif
   vec3 body=lit;
   #ifdef EARTH_WATER_BODY
   // Water photographs include the reflection of the sky on acquisition day.
   // Retain low-frequency underwater color. Suppress the old glint most
   // strongly at grazing angles, where the new reflection is visible.
   if(toBase<.5){
     vec4 sampleColor=texture2D(toMap,tileUv*toUv.xy+toUv.zw,3.);
     vec3 rgb=pow(sampleColor.rgb,vec3(2.2));
     float luminance=dot(rgb,vec3(.2126,.7152,.0722));
     vec3 scatter=rgb*(min(luminance,.048)/max(.001,luminance));
     float overhead=clamp(dot(view,up),0.,1.);
     vec3 transmitted=scatter*(vec3(.16,.23,.26)+direct*max(day,0.))*smoothstep(-.13,.08,day);
     float confidence=smoothstep(.75,1.,mask)*sampleColor.a;
     body=mix(lit,transmitted,(1.-.66*overhead*overhead)*confidence);
   }
   #endif
   vec2 disk=vec2(1.);
   #ifdef EARTH_WATER_PLANAR
   disk=mix(disk,waterDiskVisibility,waterSceneReady*(1.-smoothstep(.25,1.8,length(worldKm-waterOrigin))));
   #endif
   vec3 color=waterRadiance(body,sky,n,view,up,direct,day,smoothstep(.025,.22,footprint),localWind,disk);
   #else
   float fresnel=.0204+.9796*pow(1.-clamp(dot(n,view),0.,1.),5.);
   vec3 color=mix(lit*(1.-.50*night),sky,.65*fresnel);
   vec3 h=normalize(sunDirection+view);
   color+=direct*.36*pow(max(dot(n,h),0.),150.)*smoothstep(.01,.18,day);
   float lunar=max(0.,.5-.5*dot(moonDirection,sunDirection));
   color+=vec3(.72,.84,1.)*.14*night*lunar*lunar*smoothstep(.015,.15,dot(up,moonDirection))
        *pow(max(0.,dot(n,normalize(moonDirection+view))),130.);
   #endif
   return mix(lit,color,mask);
 }
 #endif
${require("./local-shadows").glsl}
 ${require("./panorama-sampling").glsl}
 ${require("./ocean-relief").glsl}
 ${require("./water-orbit").glsl}
 #ifdef EARTH_REFERENCE
 uniform sampler2D referenceMap;
 uniform vec4 referenceBounds;
 #endif
 ${detailDeclarations}
 #if EARTH_DETAIL_SLOTS > 0
 vec3 applyDetail(vec3 base,sampler2D page,vec4 transform,float fade,vec4 gaps){
   vec2 uv=tileUv*transform.xy+transform.zw;
   vec4 edges=vec4(uv.x,1.-uv.x,1.-uv.y,uv.y);
   vec4 derivative=fwidth(edges);
   if(any(lessThan(edges,vec4(0.)))) return base;
   // Feather a missing neighbour in screen pixels: a four-source-texel
   // apron is almost invisible across a multi-level transition. Joined
   // native neighbours keep all their edge detail.
   vec4 widths=clamp(derivative*(12.+8.*min(gaps,vec4(6.))),vec4(.004),vec4(.25));
   vec4 weights=mix(vec4(1.),smoothstep(vec4(0.),widths,edges),min(gaps,vec4(1.)));
   float weight=fade*min(min(weights.x,weights.y),min(weights.z,weights.w));
   vec4 detail=texture2D(page,uv);
   #ifdef EARTH_OPEN_IMAGERY
   weight*=detail.a;
   #endif
   return mix(base,pow(detail.rgb,vec3(2.2)),weight);
 }
 #endif
 // Northwest illumination in each point's local tangent plane. Flat ground
 // has a gain of one; the same measured slope drives every terrain layer.
 float reliefGain(vec3 up,vec3 normal){
   vec3 east=vec3(-up.y,up.x,0.)/max(length(up.xy),.00001);
   vec3 northwest=(cross(up,east)-east)*.707107;
   float slope=dot(normal,northwest)/max(.25,dot(normal,up));
   return clamp(1.+2.7*slope,.38,1.52);
 }
 vec3 overviewColor(sampler2D panorama){vec3 radial=normalize(worldKm);vec2 globalUv=vec2(atan(radial.y,radial.x)/6.2831853+.5,asin(clamp(radial.z,-1.,1.))/3.14159265+.5);return pow(samplePanorama(panorama,globalUv).rgb,vec3(2.2));}
 vec3 imageColor(sampler2D image,vec4 transform,float useBase){
   if(useBase>.5)return overviewColor(image);
   vec4 pixel=texture2D(image,tileUv*transform.xy+transform.zw);
   #ifdef EARTH_OPEN_IMAGERY
   return mix(overviewColor(earthMap),pow(pixel.rgb,vec3(2.2)),pixel.a);
   #else
   return pow(pixel.rgb,vec3(2.2));
   #endif
 }
 void main(){
 #include <logdepthbuf_fragment>
 #ifdef EARTH_ORBITAL
 vec3 albedo=imageColor(earthMap,vec4(1.,1.,0.,0.),1.);
 #else
 vec3 albedo=imageColor(toMap,toUv,toBase);
 if(blend<1.) albedo=mix(imageColor(fromMap,fromUv,fromBase),albedo,blend);
 vec4 edgeDistance=vec4(tileUv.x,1.-tileUv.x,1.-tileUv.y,tileUv.y);
 vec4 widths=clamp(fwidth(edgeDistance)*(12.+8.*min(edgeMask,vec4(6.))),vec4(.004),vec4(.20));
 vec4 weights=min(edgeMask,vec4(1.))*(1.-smoothstep(vec4(0.),widths,edgeDistance));
 float edge=max(max(weights.x,weights.y),max(weights.z,weights.w));
 if(edge>0.) albedo=mix(albedo,imageColor(parentMap,parentUv,parentBase),edge*blend);
 #ifndef EARTH_CARTOGRAPHIC
 ${detailSampling}
 #endif
 #endif
 vec3 radial=normalize(worldKm),normal=normalize(worldNormal);vec3 surface=radial*(planetRadius+max(surfaceAltitude,0.));float day=dot(radial,sunDirection);
 #ifndef EARTH_ORBITAL
 float relief=reliefGain(radial,normal);
 #ifdef EARTH_CARTOGRAPHIC
 {
 #else
 if(overlayMode>.5){
 #endif
   #ifdef EARTH_REFERENCE
   vec2 merc=vec2(atan(radial.y,radial.x),.5*log((1.+clamp(radial.z,-.99999,.99999))/(1.-clamp(radial.z,-.99999,.99999))));
   vec2 uv=(merc-referenceBounds.xy)/referenceBounds.zw;
   if(all(greaterThanEqual(uv,vec2(0.))) && all(lessThanEqual(uv,vec2(1.))))
       albedo=pow(texture2D(referenceMap,uv).rgb,vec3(2.2));
   #endif
   vec3 ink=pow(albedo,vec3(1./2.2));
   float gain=mix(1.,relief,hillshadeStrength);
   ink=ink*min(1.,gain)+(1.-ink)*max(0.,gain-1.);
   float height=surfaceAltitude*1000.;
   float footprint=max(fwidth(height),.1);
   float dist=abs(mod(height+12.5,25.)-12.5);
   float contour=(1.-smoothstep(0.,footprint,dist))*smoothstep(1.,3.,abs(height))*(1.-smoothstep(3.,8.,footprint));
   gl_FragColor=vec4(ink*(1.-.18*contour*contoursEnabled),1.);
   return;
 }
 albedo*=mix(1.,relief,.35*hillshadeStrength*smoothstep(0.,.25,day));
 #endif
 #ifndef EARTH_CARTOGRAPHIC
 if(oceanReliefWeight>0.) albedo=oceanCartography(albedo,earthMap,earthUv(radial));
 albedo=photographicReflectance(albedo,day);
 float diffuse=max(dot(normal,sunDirection),0.);vec3 direct=sunlight(surface)*cloudShadow(surface);
 #ifdef EARTH_SUN_SHADOW
 direct*=mix(.25,1.,groundSun(worldKm,normal));
 #endif
 vec3 lit=albedo*(surfaceAmbient(radial,normal,day,vec3(.025)+vec3(.28,.34,.43)*smoothstep(-.12,.18,day))+direct*(.45+.55*diffuse)*smoothstep(-.03,.06,day));
 // Satellite radiance is a regional composite, not street-level illumination.
 // Fade it based on camera altitude even when buildings are disabled or absent.
 // Using fragment distance here creates a bright band at the far horizon.
 float closeSurface=1.-smoothstep(20.,100.,max(0.,length(cameraKm)-planetRadius));
 #ifdef EARTH_WATER_ORBIT
 lit+=orbitalGlint(radial,normalize(cameraKm-worldKm),earthUv(radial),direct);
 #endif
 float night=nightWeight(surface)*lightsEnabled,signal=0.;
 if(night>0.){
  signal=citySignal(surface);
  float footprint=pow(max(0.,signal-.035),1.65);
  vec3 orbital=vec3(1.,.64,.27)*2.7*footprint;
  // At street scale the composite supplies diffuse urban skyglow on
  // reflective surfaces. Water and dark parks retain their photographed contrast.
  vec3 spill=albedo*vec3(.20,.145,.108)*footprint;
  lit+=night*mix(orbital,spill,closeSurface);
 }
 #ifdef EARTH_STYLIZED_ROADS
 vec2 roadCoord=tileUv*roadUv.xy+roadUv.zw,roadEdge=min(roadCoord,1.-roadCoord);
 if(night>0. && min(roadEdge.x,roadEdge.y)>0.){
  float height=max(0.,length(cameraKm)-planetRadius);
  float local=smoothstep(.25,1.,height)*(1.-smoothstep(12.,18.,height));
  float edge=smoothstep(0.,.02,min(roadEdge.x,roadEdge.y));
  lit+=vec3(1.,.58,.25)*texture2D(roadAtlas,roadCoord).r*.12*smoothstep(.03,.30,signal)*night*local*edge;
 }
 #endif
 #if defined(EARTH_MAPPED_WATER) && defined(EARTH_AERIAL_ATLAS)
 lit=waterLight(lit,radial,direct,day,night);
 #endif
 vec3 delta=surface-cameraKm;float distance=length(delta);vec3 transmission;vec3 haze;
 #ifdef EARTH_ATMOSPHERE_CACHE
 // Integrate the narrow grazing-angle band directly: a small cache cannot
 // resolve the rapidly changing horizon without introducing colored fringes.
 if(dot(normalize(cameraKm-surface),radial)<.2)
  haze=aerialPerspective(cameraKm,delta/max(distance,.00001),distance,transmission);
 else cachedAtmosphere(gl_FragCoord.xy/atmosphereViewport,haze,transmission);
 #else
 #ifdef EARTH_AERIAL_ATLAS
 if(aerialViewEnabled>.5 && distance<192.)haze=cachedAerial(delta/max(distance,.00001),distance,transmission);else
 #endif
 haze=aerialPerspective(cameraKm,delta/max(distance,.00001),distance,transmission);
 #endif
 gl_FragColor=vec4(displayColor(lit*transmission+haze),1.);
 #endif
 }`;

module.exports = { vertex, fragment, DETAIL_SLOTS };
