// Tabulate scattering to a finite distance below the atmosphere. The lookup's
// axes are view azimuth relative to the sun, radial elevation, and range.
// Turning the camera changes only the lookup coordinates.
const azimuth = 32, elevation = 24, ranges = 32, columns = 4;
const width = azimuth * columns, height = elevation * 2 * ranges / columns;
const coordinates = `
uniform sampler2D aerialViewAtlas;
uniform vec3 skyUp, skyForward, skyRight;
uniform float aerialViewEnabled;
vec2 aerialTile(float layer,vec2 point){
 return (vec2(mod(layer,4.)*32.,floor(layer*.25)*48.)+point)/vec2(128.,384.);
}
vec3 cachedAerial(vec3 dir,float distance,out vec3 transmission){
 float vertical=dot(dir,skyUp);
 float azimuth=atan(abs(dot(dir,skyRight)),dot(dir,skyForward)+1.e-9)/3.14159265;
 vec2 p=vec2(azimuth*31.,(sign(vertical)*sqrt(abs(vertical))*.5+.5)*23.)+.5;
 float range=sqrt(clamp(distance/192.,0.,1.))*31.;
 float layer=min(30.,floor(range));
 vec2 low=aerialTile(layer,p),high=aerialTile(layer+1.,p);
 float f=range-layer;
 vec3 scattered=mix(texture2D(aerialViewAtlas,low).rgb,texture2D(aerialViewAtlas,high).rgb,f);
 vec2 offset=vec2(0.,24./384.);
 vec3 loss=mix(texture2D(aerialViewAtlas,low+offset).rgb,texture2D(aerialViewAtlas,high+offset).rgb,f);
 transmission=1.-loss*loss;
 scattered*=scattered;return scattered/max(vec3(.0001),1.-scattered);
}`;
function create(THREE,map,uniforms,glsl){
 const renderer=map.renderer;
 const target=new THREE.WebGLRenderTarget(width,height,{minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false,stencilBuffer:false});
 Object.assign(uniforms,{aerialViewAtlas:{value:target.texture},aerialViewEnabled:{value:0}});
 const material=new THREE.ShaderMaterial({uniforms,defines:{ATMOSPHERE_STEPS:12},depthTest:false,depthWrite:false,
 vertexShader:"void main(){gl_Position=vec4(position.xy,0.,1.);}",
 fragmentShader:`precision highp float;${glsl}
 uniform vec3 skyUp,skyForward,skyRight;
 void main(){
  vec2 p=floor(gl_FragCoord.xy);float z=floor(p.x/32.)+4.*floor(p.y/48.);
  float az=mod(p.x,32.)*(3.14159265/31.);
  float vertical=mod(p.y,24.)*(2./23.)-1.;vertical=sign(vertical)*vertical*vertical;
  vec3 dir=skyUp*vertical+sqrt(max(0.,1.-vertical*vertical))*(skyForward*cos(az)+skyRight*sin(az));
  float distance=192.*(z/31.)*(z/31.);
  vec3 trans;vec3 haze=aerialPerspective(cameraKm,dir,distance,trans);
  vec3 value=mod(p.y,48.)<24.?sqrt(haze/(1.+haze)):sqrt(max(vec3(0.),1.-trans));
  gl_FragColor=vec4(value,1.);
 }`});
 const scene=new THREE.Scene(),mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);
 mesh.frustumCulled=false;scene.add(mesh);scene.userData.earthPass="aerialView";
 const viewport=new THREE.Vector4(),scissorBox=new THREE.Vector4();
 let lastHeight=Infinity,lastSun=Infinity,revision=0;
 const reset=()=>{lastHeight=Infinity};
 map.canvas.addEventListener("webglcontextrestored",reset);
 return {target,get revision(){return revision;},update(){
   const altitude=uniforms.cameraKm.value.length()-6378.137;
   uniforms.aerialViewEnabled.value=altitude>=0 && altitude<32 ? 1:0;
   if(!uniforms.aerialViewEnabled.value)return;
   const cosine=uniforms.skyUp.value.dot(uniforms.sunDirection.value);
   if(Math.abs(altitude-lastHeight)<.05 && Math.abs(cosine-lastSun)<.0005)return;
   const old=renderer.getRenderTarget(),scissor=renderer.getScissorTest();
   renderer.getViewport(viewport);renderer.getScissor(scissorBox);
   try{
    renderer.setScissorTest(false);renderer.setRenderTarget(target);renderer.render(scene,map.camera);
   }finally{renderer.setRenderTarget(old);renderer.setViewport(viewport);renderer.setScissor(scissorBox);renderer.setScissorTest(scissor)}
   lastHeight=altitude;lastSun=cosine;revision++;
 },dispose(){
   map.canvas.removeEventListener("webglcontextrestored",reset);mesh.geometry.dispose();material.dispose();target.dispose();
 }};
}
module.exports={coordinates,create};
