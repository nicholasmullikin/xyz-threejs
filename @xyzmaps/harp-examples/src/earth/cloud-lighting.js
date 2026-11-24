// Both the sky volume and the water reflection probe consume linear radiance.
const glsl = `
float cloudPhase(float cosine,float asymmetry){
 float g2=asymmetry*asymmetry;
 return (1.-g2)/pow(1.+g2-2.*asymmetry*clamp(cosine,-1.,1.),1.5);
}
// The solar transmittance table includes the shadow of the spherical Earth.
// After sunset the existing extinction probes can instead sample moonlight.
vec3 cloudLightDirection(float dayAtHorizon){
 return dayAtHorizon < -.065 ? moonDirection : sunDirection;
}
vec3 cloudRadiance(vec3 p,vec3 viewRay,vec3 lightDirection,float localDensity,float nearDensity,float tau,float opacity){
 vec3 up=normalize(p);
 float height=max(0.,length(p)-planetRadius);
 float day=dot(up,sunDirection),horizon=sqrt(2.*height/planetRadius);
 float moonPhase=.5-.5*dot(moonDirection,sunDirection);
 float moon=moonPhase*moonPhase*smoothstep(-.005,.10,dot(up,moonDirection)+horizon)
           *(1.-smoothstep(-.14,-.065,day+horizon));
 vec2 air=airCoordinates(p);
 vec3 irradiance=directLight(air)+vec3(.011,.014,.019)*moon;
 // The daylight-facing shoulders transmit more light than the interiors.
 // Use extinction from the view integration and the existing first light tap
 // for this estimate, so it costs no additional density samples.
 float relief=clamp(.65+.65*(localDensity-nearDensity),.32,1.);
 float cosine=dot(viewRay,lightDirection);
 float phase=.82*cloudPhase(cosine,.68)+.18*cloudPhase(cosine,-.24);
 // Along the view axis we already know the optical depth of the entire
 // visible column. Integrating scattering to the Sun gives tau*T/(1-T)
 // through the column and (1+T)/2 for light returning toward the camera.
 // Blend that exact collinear result into the off-axis light probes.
 float transmission=clamp(1.-opacity,.0001,1.);
 float through=-log(transmission)*transmission/max(.0001,opacity);
 float returning=.5*(1.+transmission);
 float alongLight=mix(returning,through,step(0.,cosine));
 float aligned=smoothstep(.78,.995,abs(cosine))*smoothstep(.04,.45,opacity);
 float direct=mix(exp(-tau),alongLight,.88*aligned);
 float single=direct*(.45*relief+.23*phase);
 // Higher-order scattering loses directionality and travels farther. Scale
 // it by the material at the scattering point, independent of view-ray length.
 float interior=1.-exp(-2.2*localDensity);
 float multiple=exp(-.30*tau)*(.11+.31*interior);
 float openSky=mix(.96,.30,interior)*mix(.76,1.,smoothstep(.5,8.,height));
 // Looking up into an opaque base, sky fill crosses the cloud behind the
 // scattering surface. Looking down on a cap, the exposed surface sees sky.
 float vertical=dot(viewRay,up);
 float overhead=mix(returning,through,step(0.,vertical));
 openSky*=mix(1.,overhead,.82*smoothstep(.18,.90,abs(vertical)));
 float twilight=smoothstep(-.18,.03,day+horizon);
 vec3 sky=scatteredLight(air)*2.5+vec3(.032,.052,.09)*twilight;
 return irradiance*(single+multiple)+sky*openSky
       +vec3(.00055,.00085,.0014)+moon*vec3(.0014,.0021,.0034);
}
`;
module.exports = { glsl };
