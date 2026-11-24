// The reduced ETOPO coverage mask is shared by the interactive sky fallback and
// visible terrain. Conservative coastal coverage avoids adding glint to land.
const glsl = `
#ifdef EARTH_WATER_ORBIT
uniform sampler2D globalWaterMask;
uniform float globalWaterStrength;
vec3 orbitalGlint(vec3 up,vec3 view,vec2 uv,vec3 sun){
 if(globalWaterStrength<=0.)return vec3(0.);
 float nv=max(.001,dot(up,view)), nl=dot(up,sunDirection);
 if(nl<=0.)return vec3(0.);
 float mask=smoothstep(.85,.995,texture2D(globalWaterMask,uv).r);
 if(mask<=0.)return vec3(0.);
 vec3 h=normalize(view+sunDirection);
 float nh=max(.001,dot(up,h)), slope=(1.-nh*nh)/(nh*nh);
 // Cox-Munk sea-surface slope variance at moderate wind (~5 m/s).
 const float variance=.029;
 float distribution=exp(-slope/variance)/(3.14159265*variance*nh*nh*nh*nh);
 float f=.0204+.9796*pow(1.-clamp(dot(h,view),0.,1.),5.);
 return sun*mask*globalWaterStrength*f*distribution*.25/max(.06,nv);
}
#endif`;
module.exports = { glsl };
