/* Bounded-resolution temporal reconstruction. Reproject the cloud's first-scatter
 * point, reject disocclusions using last frame's depth, and accumulate premultiplied
 * radiance/opacity. No scene-color history, so terrain and UI cannot ghost into sky.
 */
// A grazing ray can meet a shell on both sides of its tangent. Store the
// intersection branch with altitude; 15 bits still resolve about 0.55 metre.
const cloudDepthGLSL = `
float encodeCloudDepth(float altitude,float radialDirection){
 return .5*((altitude+.01)/18.1+step(0.,radialDirection));
}
float cloudDepthAltitude(float depth){return fract(depth*2.)*18.1-.01;}
float cloudShellDistance(vec3 origin,vec3 dir,float cameraAltitude,float depth){
 float altitude=cloudDepthAltitude(depth),b=dot(origin,dir);
 float qc=(cameraAltitude-altitude)*(2.*6378.137+cameraAltitude+altitude);
 float d=b*b-qc;
 // Near the limb b*b and qc can be hundreds of millions of km² and
 // nearly equal. Form the discriminant from the closest approach instead.
 if(abs(d)<.0001*b*b){
  float limb=length(cross(origin,dir)),r=6378.137+altitude;
  d=(r-limb)*(r+limb);
 }
 // Half a quantization interval in shell radius straddles the tangent.
 if(d < -4.)return -1.;
 float root=sqrt(max(0.,d)),t;
 if(depth>=.5)t=b>0.?-qc/(b+root):-b+root;
 else t=b<0.?qc/(-b+root):-b-root;
 if(t<=0.&&abs(altitude-cameraAltitude)<.0003)return .00001;
 return t;
}
`;
function createReconstruction(THREE, map, geometry, skyUniforms, cloudCameraAltitude) {
    function makeTarget(width, height) {
        const target = new THREE.WebGLRenderTarget(width, height, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: true,
            stencilBuffer: false
        });
        target.depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedShortType);
        return target;
    }
    let raw = makeTarget(1, 1);
    const history = [makeTarget(1, 1), makeTarget(1, 1)];
    const vertexShader =
        "varying vec2 ndc;void main(){ndc=position.xy;gl_Position=vec4(position.xy,1.,1.);}";
    const u = {
        ...skyUniforms,
        cloudCameraAltitude,
        colorMap: { value: null },
        depthMap: { value: null },
        historyMap: { value: null },
        previousDepth: { value: null },
        texel: { value: new THREE.Vector2(1, 1) },
        previousProjection: { value: new THREE.Matrix4() },
        previousRotation: { value: new THREE.Matrix3() },
        previousCamera: { value: new THREE.Vector3() },
        logFactor: { value: 1 },
        historyWeight: { value: 0 },
        cameraMoved: { value: 0 }
    };
    const resolve = new THREE.ShaderMaterial({
        uniforms: u,
        depthTest: true,
        depthWrite: true,
        extensions: { fragDepth: true },
        vertexShader,
        fragmentShader: `precision highp float;varying vec2 ndc;
uniform sampler2D colorMap,depthMap,historyMap,previousDepth;
uniform vec2 texel;uniform mat4 inverseProjection,previousProjection;uniform mat3 cameraRotation,previousRotation;
uniform vec3 cameraKm,previousCamera;uniform float historyWeight,cameraMoved,cloudCameraAltitude;
${cloudDepthGLSL}
void main(){
 vec2 uv=ndc*.5+.5;vec4 current=texture2D(colorMap,uv);
 // Small spatial filter also supplies a useful result on a freshly exposed pixel.
 vec4 l=texture2D(colorMap,uv-vec2(texel.x,0.)),r=texture2D(colorMap,uv+vec2(texel.x,0.));
 vec4 b=texture2D(colorMap,uv-vec2(0.,texel.y)),t=texture2D(colorMap,uv+vec2(0.,texel.y));
 vec4 lo=min(current,min(min(l,r),min(b,t))),hi=max(current,max(max(l,r),max(b,t)));
 current=(current*2.+l+r+b+t)/6.;
 float depth=texture2D(depthMap,uv).r,valid=historyWeight;vec2 oldUv=uv;
 if(depth>.999999&&current.a>.008){
  // Borrow the column that contributed most of the resolved colour.
  vec2 offset=vec2(-texel.x,0.);float alpha=l.a;
  if(r.a>alpha){offset=vec2(texel.x,0.);alpha=r.a;}
  if(b.a>alpha){offset=vec2(0.,-texel.y);alpha=b.a;}
  if(t.a>alpha)offset=vec2(0.,texel.y);
  depth=texture2D(depthMap,uv+offset).r;
 }
 if(depth<.999999){
  vec3 eye=normalize((inverseProjection*vec4(ndc,1.,1.)).xyz);
  vec3 dir=normalize(cameraRotation*eye);
  float distance=cloudShellDistance(cameraKm,dir,cloudCameraAltitude,depth);
  vec3 fromPrevious=(cameraKm-previousCamera)+dir*max(0.,distance);
  if(distance<0.)valid=0.;
  vec3 previousEye=previousRotation*fromPrevious;
  vec4 clip=previousProjection*vec4(previousEye*1000.,1.);
  oldUv=clip.xy/max(.0001,clip.w)*.5+.5;
  if(clip.w<=0.||min(oldUv.x,oldUv.y)<0.||max(oldUv.x,oldUv.y)>1.)valid=0.;
  else{
   float d=texture2D(previousDepth,oldUv).r;
   bool previousOutward=dot(previousCamera+fromPrevious,fromPrevious)>=0.;
   if(d>.999999||(d>=.5)!=previousOutward||abs(cloudDepthAltitude(d)-cloudDepthAltitude(depth))>.75)valid=0.;
  }
 }else if(cameraMoved>.5)valid=0.;
 vec4 old=clamp(texture2D(historyMap,clamp(oldUv,0.,1.)),lo,hi);
 gl_FragColor=mix(current,old,valid);
 if(depth>.999999&&cameraMoved<.5&&valid>0.)depth=texture2D(previousDepth,oldUv).r;
 gl_FragDepthEXT=depth;
}`
    });
    const scene = new THREE.Scene(),
        quad = new THREE.Mesh(geometry, resolve);
    quad.frustumCulled = false;
    scene.userData.earthPass = "cloudResolve";
    scene.add(quad);
    const composite = new THREE.ShaderMaterial({
        uniforms: {
            ...skyUniforms,
            cloudCameraAltitude,
            logFactor: u.logFactor,
            colorMap: { value: history[0].texture },
            depthMap: { value: raw.depthTexture },
            texel: u.texel,
            sampleOffset: { value: new THREE.Vector2() }
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        extensions: { fragDepth: true },
        vertexShader,
        fragmentShader: `precision highp float;varying vec2 ndc;uniform sampler2D colorMap,depthMap;uniform vec2 texel,sampleOffset;
uniform mat4 inverseProjection;uniform mat3 cameraRotation;uniform vec3 cameraKm;uniform float logFactor,cloudCameraAltitude;
${cloudDepthGLSL}
void main(){vec2 uv=ndc*.5+.5;
 #if EARTH_DEPTH_FILTER == 1
 vec2 grid=uv/texel-.5,f=fract(grid);
 vec2 sampleUv=(floor(grid)+.5+sampleOffset)*texel;
 vec2 weight=mix(1.-f,f,sampleOffset);float coverage=weight.x*weight.y;
 vec4 c=texture2D(colorMap,sampleUv);if(c.a*coverage<.001)discard;
 #else
 vec4 c=texture2D(colorMap,uv);if(c.a<.008)discard;
 vec2 sampleUv=(floor(uv/texel)+.5)*texel;
 #endif
 float depth=texture2D(depthMap,sampleUv).r;if(depth>.999999)discard;
 // A neighbouring low-resolution depth belongs to a different ray. Comparing it
 // directly against terrain hides orbital clouds on Earth's curved surface.
 // Reconstruct its scattering altitude and intersect that shell on THIS ray.
 // Depth textures store normalized altitude, not logarithmic view depth.
 vec3 eye=normalize((inverseProjection*vec4(ndc,1.,1.)).xyz),dir=normalize(cameraRotation*eye);
 float t=cloudShellDistance(cameraKm,dir,cloudCameraAltitude,depth);if(t<=0.)discard;
 #if EARTH_DEPTH_FILTER == 1
 // Distribute the bilinear footprint's optical depth among its covered taps.
 // Source-over then reconstructs its opacity when all four clear terrain.
 // Weighting each tap's optical depth directly made opaque rims expand.
 float footprintAlpha=texture2D(colorMap,uv).a;
 float fraction=coverage*c.a/max(.000001,footprintAlpha);
 float opacity=1.-pow(max(.001,1.-footprintAlpha),fraction);
 gl_FragColor=vec4(c.rgb/max(c.a,.001),opacity);
 #else
 gl_FragColor=vec4(c.rgb/max(c.a,.001),c.a);
 #endif
 gl_FragDepthEXT=log2(1.+t*1000.*max(.001,-eye.z))*logFactor*.5;}
`
    });
    // Near terrain, depth-test each bilinear sample separately so a single
    // low-resolution cloud sample cannot cut a square hole in the composite.
    // Orbit retains the single-draw path; there are no nearby terrain edges.
    const meshes = [
        [0, 0],
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1]
    ].map(([x, y], i) => {
        const material = i === 0 ? composite : composite.clone();
        if (i !== 0) Object.assign(material.uniforms, skyUniforms);
        material.uniforms.cloudCameraAltitude = cloudCameraAltitude;
        material.defines = { EARTH_DEPTH_FILTER: i === 0 ? 0 : 1 };
        material.uniforms.sampleOffset.value.set(x, y);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        return mesh;
    });
    let invalidTargets = false;
    let index = 0,
        valid = false,
        frames = 0;
    const lastSun = new THREE.Vector3(),
        lastProjection = new THREE.Matrix4(),
        lastRotation = new THREE.Matrix3(),
        lastCamera = new THREE.Vector3();
    return {
        mesh: meshes[0],
        meshes,
        get frames() {
            return frames;
        },
        invalidate() {
            invalidTargets = true;
            valid = false;
            frames = 0;
        },
        reset() {
            valid = false;
            frames = 0;
        },
        render(renderer, cloudScene, width, height) {
            if (invalidTargets || raw.width !== width || raw.height !== height) {
                invalidTargets = false;
                // Recreate attachments together: resizing a depth-texture target
                // in-place can leave a stale/incomplete framebuffer on WebGL 1
                // Firefox after repeated quality or fullscreen size changes.
                for (const t of [raw, ...history]) t.dispose();
                raw = makeTarget(width, height);
                history[0] = makeTarget(width, height);
                history[1] = makeTarget(width, height);
                u.texel.value.set(1 / width, 1 / height);
                valid = false;
                frames = 0;
            }
            const camera = map.camera,
                sun = skyUniforms.sunDirection.value;
            const moved =
                lastCamera.distanceToSquared(skyUniforms.cameraKm.value) > 0.000001 ||
                !lastRotation.equals(skyUniforms.cameraRotation.value) ||
                !lastProjection.equals(camera.projectionMatrix);
            if (lastSun.distanceToSquared(sun) > 0.000001) valid = false;
            const previous = 1 - index;
            renderer.setRenderTarget(raw);
            renderer.clear();
            renderer.render(cloudScene, camera);
            u.colorMap.value = raw.texture;
            u.depthMap.value = raw.depthTexture;
            u.historyMap.value = history[previous].texture;
            u.previousDepth.value = history[previous].depthTexture;
            u.logFactor.value = 2 / Math.log2(camera.far + 1);
            u.historyWeight.value = valid ? (moved ? 0.65 : 0.88) : 0;
            u.cameraMoved.value = moved ? 1 : 0;
            renderer.setRenderTarget(history[index]);
            renderer.clear();
            renderer.render(scene, camera);
            for (const mesh of meshes) {
                mesh.material.uniforms.colorMap.value = history[index].texture;
                mesh.material.uniforms.depthMap.value = history[index].depthTexture;
                mesh.material.uniforms.texel.value.copy(u.texel.value);
                mesh.material.uniforms.logFactor.value = u.logFactor.value;
            }
            const local = skyUniforms.cameraKm.value.length() - 6378.137 < 50;
            for (let i = 0; i < meshes.length; i++) {
                meshes[i].visible = local ? i > 0 : i === 0;
                if (i > 0) meshes[i].material.visible = composite.visible;
            }
            u.previousProjection.value.copy(camera.projectionMatrix);
            u.previousRotation.value.copy(skyUniforms.cameraRotation.value).transpose();
            u.previousCamera.value.copy(skyUniforms.cameraKm.value);
            lastSun.copy(sun);
            lastCamera.copy(skyUniforms.cameraKm.value);
            lastRotation.copy(skyUniforms.cameraRotation.value);
            lastProjection.copy(camera.projectionMatrix);
            valid = true;
            index = previous;
            frames++;
        },
        dispose() {
            for (const t of [raw, ...history]) t.dispose();
            scene.remove(quad);
            resolve.dispose();
            for (const mesh of meshes) mesh.material.dispose();
        }
    };
}
module.exports = { createReconstruction, cloudDepthGLSL };
