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
function renderBudget(width, height, name = "balanced", depthTexture = true, limit) {
    const q = quality[name] || quality.balanced;
    const steps = Math.min(q.steps, limit?.steps || q.steps);
    if (!depthTexture) return { width, height, steps: Math.min(24, steps), lowResolution: false };
    const scale = Math.min(
        q.scale,
        Math.sqrt(Math.min(q.pixels, limit?.pixels || q.pixels) / Math.max(1, width * height))
    );
    return {
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale)),
        steps,
        lowResolution: true
    };
}
const noiseGLSL = `
uniform float cloudPreset;
#if __VERSION__ >= 300
precision highp sampler3D;
uniform sampler3D cloudNoise;
vec4 cloudTileNoise(vec3 p){return texture(cloudNoise,fract(p)+vec3(.5/64.));}
#else
uniform sampler2D cloudNoise;
// Eight by eight 66px tiles, with 64px data and a wrapping one-texel gutter.
vec4 cloudTileNoise(vec3 p){
 vec3 q=fract(p)*64.;float z=floor(q.z);
 vec2 a=vec2(mod(z,8.),floor(z/8.)),b=vec2(mod(mod(z+1.,64.),8.),floor(mod(z+1.,64.)/8.));
 return mix(texture2D(cloudNoise,(a*66.+q.xy+1.5)/528.),texture2D(cloudNoise,(b*66.+q.xy+1.5)/528.),fract(q.z));
}
#endif
// Shift phase before wrapping. Smooth waves in three rotated directions keep
// neighbouring lobes coherent while decorrelating distant copies of the tile.
vec4 cloudNoise3(vec3 p){
 vec3 coord=vec3(dot(p,vec3(.36,.48,-.80)),
                 dot(p,vec3(-.80,.60,0.)),
                 dot(p,vec3(.48,.64,.60)));
 vec3 offset=.32*(sin(coord*.85+vec3(.71,2.19,4.17))
              +.45*sin(coord.yzx*1.202079+vec3(2.3,.41,3.63))
              +.25*sin(coord.zxy*1.900660+vec3(.3,6.61,1.63)));
 return cloudTileNoise(p+offset);
}
vec3 cloudWind(float height){return vec3(1.,.35,.12)*cloudTime*(.012+height*.002);}
float cloudClimate(vec3 p){return mix(.72,1.22,sqrt(max(0.,1.-abs(normalize(p).z))));}
`;
const densityGLSL = `
uniform float cloudPixelAngle;
// Noise rates below are in cycles/km. Fade an octave as its period falls
// below roughly two cloud-buffer pixels; the regional coverage stays intact.
float cloudBandWeight(float km,float frequency){
 return 1.-smoothstep(.25,.75,km*cloudPixelAngle*frequency);
}
float cloudProfile(float h,float base,float top){return smoothstep(base,base+.18,h)*(1.-smoothstep(top-.45,top,h));}
float cloudGenus(vec3 p,float h,float kind,float coverage,float distanceToEye){
 if(coverage<.035)return 0.;
 vec3 radial=normalize(p),wind=cloudWind(h),surface=radial*planetRadius;
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
 float column=1.,filtered=smoothstep(25.,180.,distanceToEye);
 float condensation=base,cap=top;
 float amount=clamp((coverage-.1)*1.35,0.,1.);
 // Keep a geographic envelope after fine structure falls below the ray footprint.
 // Anchor the whole column to its base so neighbouring heights remain coherent.
 vec3 ground=surface+cloudWind(base);
 float regional=.5;
 if(filtered>.001){
  float wide=smoothstep(350.,2000.,distanceToEye);
  if(wide<.999)regional=cloudNoise3(ground*.0071).a;
  if(wide>.001)regional=mix(regional,cloudNoise3(ground*.0017).a,wide);
 }
 float anomaly=regional-.5;
 vec3 q=(surface+wind)*scale+radial*(h-base)*.11;
 if(kind>8.5){
  bool storm=kind>9.5;
  // One coherent footprint for each updraft. The nearest-cell distance
  // rounds its sides; broad value noise varies how high neighbouring towers rise.
  vec4 cell=vec4(.55,.56,.45,.52);
  float footprintFade=smoothstep(150.,680.,distanceToEye);
  if(footprintFade<.999)cell=cloudNoise3(ground*(storm?.018:.035));
  float height=(h-base)/(top-base);
  float anvil=storm?smoothstep(.65,.88,height):0.;
  float edge=mix(.40,.49,height)-.19*anvil+.12*(1.-amount);
  float footprint=cell.g+.18*(cell.a-.5);
  column=mix(smoothstep(edge-.075,edge+.12,footprint),(storm?.28:.23)*clamp(1.+(storm?3.8:6.)*anomaly,.015,2.3),footprintFade);
  if(column<.005)return 0.;
  // Moist updraft cores condense first. The weaker perimeter starts a
  // little higher, breaking up the shelf at the bottom of the cloud.
  float edgeLifting=1.-smoothstep(.36,.70,footprint);
  condensation+=.05+.40*(1.-amount)+(.06+.38*edgeLifting)*(1.-footprintFade);
  if(!storm){
   float tower=clamp(.08+1.32*(cell.g-.30)+.72*(cell.a-.30),.12,1.);
   cap=base+(top-base)*mix(tower,.64+.45*anomaly,footprintFade);
  }
  // Leave room for the smaller lobes that displace the boundary below.
  if(h<condensation-.10 || h>cap+.30)return 0.;
  // Tilt the high lobes downwind while their feet stay together.
  // The same cellular channels supply both broad domes and smaller turrets.
  q-=vec3(1.,.35,.12)*height*height*(storm?.16:.055);
  q+=vec3(cell.a-.5,cell.r-.5,cell.a-cell.r)*.12;
 } else if(kind<1.5){
  // Sample in the prevailing wind frame using Earth-fixed coordinates so
  // filaments cross the date line continuously. Falling ice trails bend
  // downwind with depth; the slower field steers neighbouring strands together.
  vec3 advected=surface+wind;
  vec3 windFrame=vec3(dot(advected,vec3(.938,.328,.113)),
                      dot(advected,vec3(-.330,.944,0.)),
                      dot(advected,vec3(-.107,-.037,.994)));
  float fall=(top-h)/(top-base);
  vec3 bandCoord=windFrame*vec3(.008,.036,.028);
  vec4 band=vec4(.5);
  float bandFade=smoothstep(160.,760.,distanceToEye);
  if(bandFade<.999)band=cloudNoise3(bandCoord);
  band.a=mix(band.a,regional,bandFade);
  q=windFrame*vec3(.011,.17,.095)+vec3(.19*fall*fall,.36*(band.a-.5),.32*(band.g-.5));
  q+=vec3(0.,.052,-.033)*(h-base);
  float filament=.50;
  if(filtered<.999){
   vec4 fibers=cloudNoise3(q);
   filament=mix(fibers.a,fibers.g,.25);
  }
  float fibers=mix(smoothstep(.40,.68,filament),.36,filtered);
  float ice=fibers*smoothstep(.32+.21*(1.-amount),.64,band.a);
  return ice*profile*.18*amount;
 }
 vec4 n=vec4(.52,.47,.46,.52)+.60*anomaly;
 if(filtered<.999)n=mix(cloudNoise3(q),n,filtered);
 threshold+=.25*(1.-amount);
 // Broaden the anvil where the rising column reaches its top.
 if(kind>9.5){threshold+=smoothstep(2.,9.,h)*.08-smoothstep(10.,13.,h)*.17;}
 else if(kind>8.5){threshold+=smoothstep(base,top,h)*.045-.055;}
 else if(kind>6.5&&kind<7.5){threshold+=smoothstep(base,top,h)*.08+.044*filtered;}
 float shape=n.r;
 if(kind>8.5){
  // A shallow, gently varying base under a field of rising cells. Couple
  // the fine cap displacement to the same lobes that shape the tower wall.
  float lobes=.65*n.g+.35*n.b;
  float localBase=condensation+.15*(n.a-.5)*(1.-filtered);
  float localCap=min(top,cap+.55*(lobes-.47)*(1.-filtered));
  float vertical=(h-localBase)/max(.30,localCap-localBase);
  profile=smoothstep(0.,.16,h-localBase)*(1.-smoothstep(localCap-.35,localCap,h));
  if(profile<.001)return 0.;
  // Stronger mixing at the top curls alternating lobes into and out of
  // the cloud. The dense central updraft remains continuous.
  float billow=smoothstep(.08,.68,vertical);
  shape=mix(n.r,n.g,.24)+mix(.08,.32,billow)*(n.b-.43);
 }
 if(kind>1.5&&kind<2.5||kind>3.5&&kind<4.5)shape=mix(n.r,n.b,.5);
 // Distant clouds keep their coverage while subpixel erosion fades out.
 float detail=(1.-smoothstep(8.,35.,distanceToEye))*cloudBandWeight(distanceToEye,.32*12.);
 float width=mix(.09,.19,filtered);
 float body=smoothstep(threshold-width,threshold+width,shape)*column;
 if(kind>2.5&&kind<3.5||kind>4.5&&kind<6.5||kind>7.5&&kind<8.5){
  body*=1.+filtered*.65*anomaly;
 }
 if(body<.005)return 0.;
 if(detail>.01&&kind>3.5&&kind<10.5){
  vec4 fine=cloudNoise3((p+wind)*.32);
  if(kind>8.5){
   // Entrainment tears the thin perimeter into wisps. Modulate the
   // erosion locally, retaining a connected body and stronger wet cores.
   float fringe=1.-smoothstep(.16,.82,body);
   float tear=smoothstep(.20,.74,mix(fine.b,fine.a,.28));
   body=max(0.,body-detail*fringe*(.10+.26*tear));
  } else body=max(0.,body-(1.-fine.b)*.23*detail*(1.-body));
 }
 float thin=kind<3.5?.65:1.;
 return body*profile*extinction*thin*mix(.25,1.,amount);
}
// A plane of regional cloud cells stays coherent through the cloud depth. Using
// the same fine-scale rate vertically and horizontally makes the light probes
// repeatedly cross unrelated decks, producing smooth white islands with rims.
float layerProfile(float height,float base,float top){
 float t=clamp((height-base)/(top-base),0.,1.);
 return smoothstep(0.,.18,t)*(1.-smoothstep(.62,1.,t));
}
vec4 regionalCloudColumn(vec3 ground,vec3 radial,float h,float cover,vec4 weather,float distanceToEye){
 // Satellite coverage and the broad synoptic field anchor every LOD. Broken
 // decks resolve into cell walls or rounded cells; fronts resolve into ribbons.
 float amount=smoothstep(.04,.96,cover);
 float front=smoothstep(.40,.69,weather.a)*smoothstep(.38,.78,amount);
 vec3 along=vec3(.938,.328,.113);
 vec3 air=ground-along*dot(ground,along)*.76;
 float ribbon=cloudNoise3(air*.0038+weather.gba*.40).a;
 float anchor=mix(weather.r,ribbon,front*.82);
 float resolved=1.-smoothstep(750.,3600.,distanceToEye);
 float structure=anchor;
 float iceShape=ribbon,capRelief=0.;
 if(resolved>.001){
  // Wind stretches the mesoscale moisture field. Use continuous value noise
  // for its outline. Nearest-cell distance belongs mainly on the cloud tops:
  // when it controls the whole column, each seed cuts a circular blue hole.
  vec3 bank=mix(ground,air,.42);
  vec4 cell=cloudNoise3(bank*.010+weather.gba*.34);
  // Open cells have a clearer centre; closed cells have the opposite polarity.
  float closed=smoothstep(.30,.68,amount+.32*(weather.g-.5));
  float cellular=mix(1.-cell.g,cell.g,closed);
  float deck=mix(cell.a,cellular,.18+.10*(1.-front));
  float fineBand=cloudBandWeight(distanceToEye,.055*4.);
  float detail=(1.-smoothstep(180.,950.,distanceToEye))*fineBand;
  if(detail>.001){
   vec4 fine=cloudNoise3(mix(ground,air,.24)*.055+radial*h*.023+cell.agr*.32);
   deck+=detail*(mix(fine.a,fine.r,.25)-.5)*.64;
   // Rounded turrets ride on the bank tracked from orbit. Keep their height
   // coherent through the column, including where its opacity is saturated.
   capRelief=fineBand*(1.-smoothstep(65.,350.,distanceToEye))*(fine.g-.55)*mix(.90,.28,front);
   float fringe=1.-smoothstep(.12,.28,abs(deck-.5));
   float erosion=(1.-smoothstep(12.,90.,distanceToEye))*fringe*cloudBandWeight(distanceToEye,.13*12.);
   if(erosion>.01){
    vec4 edge=cloudNoise3(ground*.13+radial*h*.11+fine.gba*.14);
    deck+=erosion*(edge.b-.47)*.30;
    capRelief+=erosion*(edge.g-.55)*.24;
   }
  }
  structure+=resolved*(deck-.5)*mix(.80,.43,front);
  iceShape+=resolved*(cell.a-.5)*.32;
 }
 float edge=.70-.38*amount;
 float width=mix(.20,.10,resolved);
 float body=smoothstep(edge-width,edge+width,structure);
 // A footprint contains a distribution of cloudy and clear subcolumns.
 // Leave holes between systems at orbital scales without binary silhouettes.
 body=mix(body,amount*(.55+.90*smoothstep(.23,.79,anchor)),.42*(1.-resolved));
 float deep=smoothstep(.68,.92,cover)*smoothstep(.49,.71,weather.a);
 float top=mix(2.1,4.7,smoothstep(.23,.78,weather.g));
 top=mix(top,10.,deep)*(.72+.58*smoothstep(.22,.79,structure));
 top*=1.+capRelief;
 // Moist overcast banks retain a little condensate through local minima.
 // Broken and dry weather can still expose the surface through the full deck.
 float humid=smoothstep(.56,.88,amount)*smoothstep(.37,.60,anchor);
 float low=(body+(1.-body)*.12*humid)*(.32+.82*amount);
 float middle=amount*(.04+.30*body)*smoothstep(.30,.78,weather.b+.33*front);
 float ice=amount*(.003+.085*smoothstep(.53,.80,iceShape+.15*front));
 return vec4(top,low,middle,ice);
}
float columnDensity(vec4 column,float h){
 // Taller, broken cells form above a locally varying condensation level.
 // Their sparse fringes lift and soften, while shallow saturated decks keep
 // a broad, level underside. All inputs interpolate in the cached marcher.
 float towers=smoothstep(2.65,5.6,column.r)*(1.-smoothstep(.12,.35,column.b));
 float fringe=1.-smoothstep(.10,.81,column.g);
 float base=.52+towers*(.16+.48*fringe);
 float low=layerProfile(h,base,column.r);
 low*=mix(1.,smoothstep(base,base+.78,h),towers*fringe*.55);
 return low*column.g
       +layerProfile(h,2.4,6.8)*column.b
       +layerProfile(h,7.2,11.4)*column.a;
}
float regionalWeight(float distanceToEye){
 return smoothstep(20.,38.,cloudCameraAltitude)*smoothstep(35.,110.,distanceToEye);
}
float historicCoverage(vec2 uv){
 uv.x+=cloudTime*.000002;
 return smoothstep(.07,.90,texture2D(cloudMap,uv).r);
}
vec4 sampleRegionalColumn(vec3 p,float distanceToEye){
 float cover=historicCoverage(earthUv(p));
 if(cover<.035)return vec4(1.,0.,0.,0.);
 vec3 radial=normalize(p),ground=radial*planetRadius+cloudWind(0.);
 float h=clamp((length(p)-planetRadius)/cloudClimate(p),0.,14.);
 return regionalCloudColumn(ground,radial,h,cover,cloudNoise3(ground*.0013),distanceToEye);
}
float forecastCloudDensity(vec3 p,float h,float distanceToEye,vec3 fraction,vec4 weather){
 // Deep convection needs cloud cover at all levels. GFS supplies the
 // layer fractions; the weather noise selects individual cloud forms.
 float depth=min(min(fraction.r,fraction.g),fraction.b);
 float storm=smoothstep(.62,.82,depth)*smoothstep(.48,.66,weather.a);
 if(storm>.12)return cloudGenus(p,h,10.,depth,distanceToEye)*storm;
 float density=0.;
 if(h<4.6 && fraction.r>.035){float kind=weather.g<.28?8.:(weather.g<.53?7.:9.);density=cloudGenus(p,h,kind,fraction.r,distanceToEye);}
 if(h<7.){float kind=weather.b<.3?6.:(weather.b<.57?5.:4.);density+=cloudGenus(p,h,kind,fraction.g,distanceToEye)*smoothstep(.18,.42,fraction.g);return density;}
 float kind=weather.r<.40?3.:(weather.r<.53?2.:1.);
 return cloudGenus(p,h,kind,fraction.b,distanceToEye)*smoothstep(.12,.35,fraction.b);
}
float cloudDensity(vec3 p,float distanceToEye){
 float h=(length(p)-planetRadius)/cloudClimate(p);
 if(h<.35||h>14.)return 0.;
 if(cloudPreset>.5)return cloudGenus(p,h,cloudPreset,.83,distanceToEye);
 if(cloudPreset<-.5){
  vec3 fraction=texture2D(cloudMap,earthUv(p)).rgb;
  if(max(max(fraction.r,fraction.g),fraction.b)<.035)return 0.;
  vec3 ground=normalize(p)*planetRadius+cloudWind(0.);
  return forecastCloudDensity(p,h,distanceToEye,fraction,cloudNoise3(ground*.0013));
 }
 return columnDensity(sampleRegionalColumn(p,distanceToEye),h);
}
`;
module.exports = { presets, quality, renderBudget, noiseGLSL, densityGLSL };
