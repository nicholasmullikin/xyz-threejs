/* Cloud genera follow the WMO Cloud Atlas. Heights are illustrative MSL ranges;
 * latitude adjusts the upper troposphere. This is a visual model, not weather data.
 * Techniques: Nubis (weather map, Perlin-Worley, height profiles), Beer extinction,
 * dual-lobe phase, and inexpensive multiple-scattering/self-shadow approximations.
 */
const presets = [
    { id: 0, name: "Automatic", base: 0.35, top: 18 },
    { id: 1, name: "Cirrus", base: 8.5, top: 11.5 },
    { id: 2, name: "Cirrocumulus", base: 8, top: 9.4 },
    { id: 3, name: "Cirrostratus", base: 8, top: 10.5 },
    { id: 4, name: "Altocumulus", base: 3.5, top: 5.5 },
    { id: 5, name: "Altostratus", base: 3, top: 6.8 },
    { id: 6, name: "Nimbostratus", base: 0.6, top: 7 },
    { id: 7, name: "Stratocumulus", base: 0.7, top: 2.4 },
    { id: 8, name: "Stratus", base: 0.35, top: 1.2 },
    { id: 9, name: "Cumulus", base: 0.9, top: 4.6 },
    { id: 10, name: "Cumulonimbus", base: 0.8, top: 14 }
];
const quality = {
    low: { steps: 24, pixels: 130000, scale: 0.4 },
    balanced: { steps: 40, pixels: 260000, scale: 0.5 },
    high: { steps: 64, pixels: 560000, scale: 0.65 }
};
function renderBudget(width, height, name = "balanced", depthTexture = true) {
    const q = quality[name] || quality.balanced;
    if (!depthTexture) return { width, height, steps: 24, lowResolution: false };
    const scale = Math.min(q.scale, Math.sqrt(q.pixels / Math.max(1, width * height)));
    return {
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale)),
        steps: q.steps,
        lowResolution: true
    };
}
const noiseGLSL = `
uniform sampler2D cloudNoise;
uniform float cloudPreset;
// Eight by eight 66px tiles, with 64px data and a wrapping one-texel gutter.
vec4 cloudNoise3(vec3 p){
 vec3 q=fract(p)*64.;float z=floor(q.z);
 vec2 a=vec2(mod(z,8.),floor(z/8.)),b=vec2(mod(mod(z+1.,64.),8.),floor(mod(z+1.,64.)/8.));
 return mix(texture2D(cloudNoise,(a*66.+q.xy+1.5)/528.),texture2D(cloudNoise,(b*66.+q.xy+1.5)/528.),fract(q.z));
}
vec3 cloudWind(float height){return vec3(1.,.35,.12)*cloudTime*(.012+height*.002);}
float cloudClimate(vec3 p){return mix(.72,1.22,sqrt(max(0.,1.-abs(normalize(p).z))));}
`;
const densityGLSL = `
float cloudProfile(float h,float base,float top){return smoothstep(base,base+.18,h)*(1.-smoothstep(top-.45,top,h));}
float cloudGenus(vec3 p,float h,float kind,float coverage,float distanceToEye){
 vec3 wind=cloudWind(h),surface=normalize(p)*planetRadius;
 float base=.9,top=4.6,scale=.065,extinction=1.35,threshold=.52;
 if(kind<1.5){base=8.5;top=11.5;scale=.022;extinction=.12;threshold=.48;}
 else if(kind<2.5){base=8.;top=9.4;scale=.24;extinction=.28;threshold=.48;}
 else if(kind<3.5){base=8.;top=10.5;scale=.014;extinction=.12;threshold=.24;}
 else if(kind<4.5){base=3.5;top=5.5;scale=.14;extinction=.85;threshold=.47;}
 else if(kind<5.5){base=3.;top=6.8;scale=.012;extinction=.55;threshold=.24;}
 else if(kind<6.5){base=.6;top=7.;scale=.022;extinction=1.7;threshold=.22;}
 else if(kind<7.5){base=.7;top=2.4;scale=.095;extinction=1.45;threshold=.43;}
 else if(kind<8.5){base=.35;top=1.2;scale=.013;extinction=1.55;threshold=.23;}
 else if(kind>9.5){base=.8;top=14.;scale=.025;extinction=1.9;threshold=.52;}
 float profile=cloudProfile(h,base,top);if(profile<.001)return 0.;
 float column=1.,filtered=smoothstep(90.,650.,distanceToEye);
 if(kind>8.5){
  float envelope=.6;
  if(filtered<.999)envelope=cloudNoise3((surface+wind)*(kind>9.5?.018:.035)).g;
  float edge=kind>9.5?mix(.48,.20,smoothstep(9.,13.,h)):.52;
  column=mix(smoothstep(edge,edge+.13,envelope),kind>9.5?.32:.18,filtered);
  if(column<.005)return 0.;
  if(kind<9.5){float cap=base+(top-base)*mix(clamp((envelope-.28)/.48,.12,1.),.75,filtered);profile=cloudProfile(h,base,cap);}
 }

 // Weather coverage is the inexpensive conservative density test.
 if(coverage<.035)return 0.;
 vec3 q=(surface+wind)*scale+normalize(p)*(h-base)*.11;
 if(kind<1.5)q=(surface+wind)*vec3(.008,.14,.038)+vec3(h*.13,0.,0.);
 vec4 n=vec4(.55,.45,.45,.52);
 if(filtered<.999)n=mix(cloudNoise3(q),n,filtered);
 float amount=clamp((coverage-.1)*1.35,0.,1.);
 threshold+=.25*(1.-amount);
 // Convective towers narrow with height and spread into an ice anvil aloft.
 if(kind>9.5){threshold+=smoothstep(2.,9.,h)*.12-smoothstep(10.,13.,h)*.17;}
 else if(kind>8.5){threshold+=smoothstep(base,top,h)*.17;}
 else if(kind>6.5&&kind<7.5){threshold+=smoothstep(base,top,h)*.08;}
 float shape=n.r;
 if(kind<1.5&&filtered<.999){float streak=cloudNoise3(q*vec3(.6,1.8,1.)+n.g*.11).a;shape=mix(mix(n.a,streak,.6),.52,filtered);}
 if(kind>1.5&&kind<2.5||kind>3.5&&kind<4.5)shape=mix(n.r,n.b,.5);
 // Distant clouds keep their coverage while subpixel erosion fades out.
 float detail=1.-smoothstep(25.,110.,distanceToEye);
 float body=smoothstep(threshold-.09,threshold+.09,shape)*column;
 if(body<.005)return 0.;
 if(detail>.01&&kind>3.5&&kind<10.5){float erosion=cloudNoise3((p+wind)*.32).b;body=max(0.,body-(1.-erosion)*.23*detail*(1.-body));}
 float thin=kind<3.5?.65:1.;
 return body*profile*extinction*thin*mix(.25,1.,amount);
}
float cloudDensity(vec3 p,float distanceToEye){
 float h=(length(p)-planetRadius)/cloudClimate(p);
 if(h<.35||h>14.)return 0.;
 if(cloudPreset>.5)return cloudGenus(p,h,cloudPreset,.83,distanceToEye);
 vec2 uv=earthUv(p);uv.x+=cloudTime*.000002;
 float cover=smoothstep(.07,.90,texture2D(cloudMap,uv).r);if(cover<.035)return 0.;
 vec3 surface=normalize(p)*planetRadius;
 vec4 weather=cloudNoise3((surface+cloudWind(0.))*.0013);
 float storm=smoothstep(.62,.82,cover)*smoothstep(.48,.66,weather.a);
 if(storm>.12)return cloudGenus(p,h,10.,cover,distanceToEye)*storm;
 float density=0.;
 if(h<4.6){float kind=weather.g<.28?8.:(weather.g<.53?7.:9.);density=cloudGenus(p,h,kind,cover,distanceToEye);}
 if(h<7.){float kind=weather.b<.3?6.:(weather.b<.57?5.:4.);density+=cloudGenus(p,h,kind,cover,distanceToEye)*smoothstep(.18,.42,cover);return density;}
 float kind=weather.r<.40?3.:(weather.r<.53?2.:1.);
 return cloudGenus(p,h,kind,cover,distanceToEye)*smoothstep(.12,.35,cover);
}
`;
module.exports = { presets, quality, renderBudget, noiseGLSL, densityGLSL };
