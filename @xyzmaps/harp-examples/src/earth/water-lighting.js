// Both certified ocean and mapped water use linear incident radiance.
// The sun disk is integrated separately from the continuous sky radiance.
const glsl = `
#ifdef EARTH_WATER_MODEL
${require("./water-reflections").cloudSampling}
uniform float waterWind;
#ifdef EARTH_WATER_PLANAR
uniform vec2 waterDiskVisibility;
#endif
#ifdef EARTH_WATER_BODY
// The long gravity waves cross the shorter FFT bands at different velocities.
// Use Earth-fixed phases so moving between tiles never restarts the swell.
vec3 waterSwell(vec3 p,vec3 up,float strength){
 vec3 a=vec3(.588,.784,.196),b=vec3(-.739,.361,.569);
 vec3 gradient=a*cos(dot(p,a)*22.-cloudTime*.43)+.43*b*cos(dot(p,b)*47.-cloudTime*.68);
 return (gradient-up*dot(up,gradient))*strength*sqrt(waterWind);
}
#endif
float waterRoughness(float unresolved,float localWind){
 #ifdef EARTH_WATER_FILTER
 return sqrt(.0025+localWind*(.014+.035*clamp(unresolved,0.,1.)));
 #else
 return .155;
 #endif
}
float waterGlint(vec3 n,vec3 v,vec3 l,float alpha){
 float nv=max(.001,dot(n,v)), nl=dot(n,l);
 if(nl<=0.)return 0.;
 vec3 h=normalize(l+v);
 float nh=clamp(dot(n,h),0.,1.), vh=clamp(dot(v,h),0.,1.);
 float a2=alpha*alpha, d=nh*nh*(a2-1.)+1.;
 float visibility=.5/max(.0001,nl*sqrt(nv*nv*(1.-a2)+a2)+nv*sqrt(nl*nl*(1.-a2)+a2));
 return (.0204+.9796*pow(1.-vh,5.))*a2*nl*visibility/(3.14159*d*d);
}
#ifdef EARTH_WATER_SLOPES
float waveVisibility(float cosine,float slope){
 float a=cosine/max(.0001,slope);
 if(a>=1.6)return 1.;
 float a2=a*a;
 return (3.535*a+2.181*a2)/(1.+2.276*a+2.577*a2);
}
float directionalGlint(vec3 n,vec3 v,vec3 l,vec3 up,float unresolved,float localWind){
 float nv=max(.001,dot(n,v)),nl=dot(n,l);
 if(nl<=0.)return 0.;
 vec3 east=vec3(-up.y,up.x,0.)/max(.0001,length(up.xy));
 vec3 wind=east*.84+cross(up,east)*.5426;
 vec3 t=normalize(wind-n*dot(wind,n)),b=cross(n,t);
 // Cox-Munk total slope variance. Resolved normal bands already carry
 // part of it; restore their variance to the lobe as pixels cover more sea.
 float variance=.003+.00512*(.5+10.*localWind);
 float width=mix(.25,1.,clamp(unresolved,0.,1.))*variance+.000006;
 vec2 a2=width*vec2(1.20,.80);
 vec3 h=normalize(v+l);
 float nh=max(.001,dot(n,h));
 vec2 slope=vec2(dot(h,t),dot(h,b))/nh;
 float exponent=dot(slope,slope/a2);
 if(exponent>18.)return 0.;
 float D=exp(-exponent)/(3.14159*sqrt(a2.x*a2.y)*nh*nh*nh*nh);
 vec2 axes=sqrt(a2);
 float visible=waveVisibility(nv,length(axes*vec2(dot(t,v),dot(b,v))))*
               waveVisibility(nl,length(axes*vec2(dot(t,l),dot(b,l))));
 float f=.0204+.9796*pow(1.-clamp(dot(h,v),0.,1.),5.);
 return D*f*visible/(4.*nv);
}
#endif
vec3 waterRadiance(vec3 body,vec3 sky,vec3 n,vec3 v,vec3 up,vec3 sun,float day,float unresolved,float localWind,vec2 disk){
 float f=.0204+.9796*pow(1.-clamp(dot(n,v),0.,1.),5.);
 float alpha=waterRoughness(unresolved,localWind);
 float moonPhase=.5-.5*dot(moonDirection,sunDirection);
 float moonHeight=smoothstep(-.01,.08,dot(up,moonDirection));
 float darkness=1.-smoothstep(-.12,-.01,day);
 vec3 lunar=vec3(.66,.77,1.)*disk.y*.006*moonPhase*moonPhase*moonHeight;
 #ifdef EARTH_WATER_CLOUDS
 if(waterCloudReady>.5 && moonHeight>0. && darkness>0.)lunar*=1.-cloudReflectionSample(moonDirection).a;
 #endif
 sky+=lunar*darkness*.095;
 body+=lunar*darkness*vec3(.009,.025,.038);
 #ifdef EARTH_WATER_CLOUDS
 if(waterCloudReady>.5 && day>0.){
   float diskVisibility=1.-cloudReflectionSample(sunDirection).a;
   sun=min(sun,sunlight(up*planetRadius)*diskVisibility);
 }
 #endif
 #ifdef EARTH_WATER_SLOPES
 float solar=directionalGlint(n,v,sunDirection,up,unresolved,localWind);
 #else
 float solar=waterGlint(n,v,sunDirection,alpha);
 #endif
 return mix(body,sky,f)+sun*disk.x*solar*smoothstep(-.007,.007,day)
   +lunar*waterGlint(n,v,moonDirection,alpha)*darkness;
}
#endif
`;
module.exports = { glsl };
