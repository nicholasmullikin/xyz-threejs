const EarthAtmosphere = require("./atmosphere");
const EarthEnvironment = require("./environment");
const vertex = `#include <common>
 #include <logdepthbuf_pars_vertex>
 uniform vec3 cameraKm;varying vec2 tileUv;varying vec3 worldKm;varying vec3 worldNormal;varying float surfaceAltitude;
 void main(){tileUv=uv;vec4 world=modelMatrix*vec4(position,1.);worldKm=world.xyz*.001+cameraKm;worldNormal=mat3(modelMatrix)*normal;surfaceAltitude=length(worldKm)-6378.137;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
 #include <logdepthbuf_vertex>
 }`;
const fragment = `precision highp float;
 #include <logdepthbuf_pars_fragment>
 uniform float overlayMode;uniform float contoursEnabled;uniform float hillshadeStrength;uniform sampler2D parentMap;uniform vec4 parentUv;uniform float parentBase;uniform vec4 edgeMask;uniform sampler2D fromMap;uniform sampler2D toMap;uniform sampler2D earthMap;uniform vec4 fromUv;uniform vec4 toUv;uniform float fromBase;uniform float toBase;uniform float blend;
 varying vec2 tileUv;varying vec3 worldKm;varying vec3 worldNormal;varying float surfaceAltitude;
 ${EarthAtmosphere.glsl}
 ${EarthEnvironment.glsl}
 vec3 imageColor(sampler2D image,vec4 transform,float useBase){vec3 radial=normalize(worldKm);vec2 globalUv=vec2(atan(radial.y,radial.x)/6.2831853+.5,asin(clamp(radial.z,-1.,1.))/3.14159265+.5);vec3 color=useBase>.5?texture2D(earthMap,globalUv).rgb:texture2D(image,tileUv*transform.xy+transform.zw).rgb;return pow(color,vec3(2.2));}
 void main(){
 #include <logdepthbuf_fragment>
 vec3 albedo=mix(imageColor(fromMap,fromUv,fromBase),imageColor(toMap,toUv,toBase),blend);
 vec4 edgeDistance=vec4(tileUv.x,1.-tileUv.x,1.-tileUv.y,tileUv.y);
 vec4 weights=edgeMask*(1.-smoothstep(vec4(0.),vec4(.08),edgeDistance));
 float edge=max(max(weights.x,weights.y),max(weights.z,weights.w));
 if(edge>0.) albedo=mix(albedo,imageColor(parentMap,parentUv,parentBase),edge*blend);
 vec3 radial=normalize(worldKm),normal=normalize(worldNormal);vec3 surface=radial*(planetRadius+max(surfaceAltitude,0.));float day=dot(radial,sunDirection);
 float diffuse=max(dot(normal,sunDirection),0.);vec3 direct=sunlight(surface)*cloudShadow(surface);
 vec3 lit=albedo*(vec3(.025)+vec3(.28,.34,.43)*smoothstep(-.12,.18,day)+direct*(.45+.55*diffuse)*smoothstep(-.03,.06,day));
 // Satellite radiance is a regional composite, not street-level illumination.
 // Near cities, use the detailed surface to avoid lighting rivers and whole blocks.
 float urbanSurface=smoothstep(.08,.35,dot(albedo,vec3(.2126,.7152,.0722)))*(1.-smoothstep(.02,.12,albedo.b-albedo.r));
 lit+=nightEmission(surface)*mix(urbanSurface*.025,1.,smoothstep(12.,120.,length(surface-cameraKm)));
 if(overlayMode>.5){float height=surfaceAltitude*1000.;float interval=200.;float width=max(fwidth(height),1.);float contour=1.-smoothstep(0.,width*1.4,min(mod(height,interval),interval-mod(height,interval)));lit*=mix(1.,.55+.45*diffuse,hillshadeStrength);lit=mix(lit,vec3(.12,.08,.04),contour*.6*contoursEnabled);}
 vec3 delta=surface-cameraKm;float distance=length(delta);vec3 transmission;vec3 haze=atmosphere(cameraKm,delta/max(distance,.00001),distance,transmission);
 gl_FragColor=vec4(displayColor(lit*transmission+haze),1.);
 }`;

module.exports = { vertex, fragment };
