/* Bounded-resolution temporal reconstruction. Reproject the cloud's first-scatter
 * point, reject disocclusions using last frame's depth, and accumulate premultiplied
 * radiance/opacity. No scene-color history, so terrain and UI cannot ghost into sky.
 */
function createReconstruction(THREE, map, geometry, skyUniforms) {
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
uniform vec3 cameraKm,previousCamera;uniform float historyWeight,cameraMoved;
float shellDistance(vec3 origin,vec3 dir,float radius){float b=dot(origin,dir),d=b*b-dot(origin,origin)+radius*radius;if(d<0.)return -1.;float t=-b-sqrt(d);return t>0.?t:-b+sqrt(d);}
void main(){
 vec2 uv=ndc*.5+.5;vec4 current=texture2D(colorMap,uv);
 // Small spatial filter also supplies a useful result on a freshly exposed pixel.
 vec4 l=texture2D(colorMap,uv-vec2(texel.x,0.)),r=texture2D(colorMap,uv+vec2(texel.x,0.));
 vec4 b=texture2D(colorMap,uv-vec2(0.,texel.y)),t=texture2D(colorMap,uv+vec2(0.,texel.y));
 vec4 lo=min(current,min(min(l,r),min(b,t))),hi=max(current,max(max(l,r),max(b,t)));
 current=(current*2.+l+r+b+t)/6.;
 float depth=texture2D(depthMap,uv).r,valid=historyWeight;vec2 oldUv=uv;
 if(depth>.999999&&current.a>.008){depth=min(min(texture2D(depthMap,uv-vec2(texel.x,0.)).r,texture2D(depthMap,uv+vec2(texel.x,0.)).r),min(texture2D(depthMap,uv-vec2(0.,texel.y)).r,texture2D(depthMap,uv+vec2(0.,texel.y)).r));}
 if(depth<.999999){
  vec3 eye=normalize((inverseProjection*vec4(ndc,1.,1.)).xyz);
  vec3 dir=normalize(cameraRotation*eye);
  float distance=shellDistance(cameraKm,dir,6378.137+depth*18.1-.01);
  vec3 point=cameraKm+dir*max(0.,distance);
  if(distance<0.)valid=0.;
  vec3 previousEye=previousRotation*(point-previousCamera);
  vec4 clip=previousProjection*vec4(previousEye*1000.,1.);
  oldUv=clip.xy/max(.0001,clip.w)*.5+.5;
  if(clip.w<=0.||min(oldUv.x,oldUv.y)<0.||max(oldUv.x,oldUv.y)>1.)valid=0.;
  else{
   float d=texture2D(previousDepth,oldUv).r;
   if(d>.999999||abs(d-depth)*18.1>.75)valid=0.;
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
    scene.add(quad);
    const composite = new THREE.ShaderMaterial({
        uniforms: {
            ...skyUniforms,
            logFactor: u.logFactor,
            colorMap: { value: history[0].texture },
            depthMap: { value: raw.depthTexture },
            texel: u.texel
        },
        transparent: true,
        depthTest: true,
        depthWrite: false,
        extensions: { fragDepth: true },
        vertexShader,
        fragmentShader: `precision highp float;varying vec2 ndc;uniform sampler2D colorMap,depthMap;uniform vec2 texel;
uniform mat4 inverseProjection;uniform mat3 cameraRotation;uniform vec3 cameraKm;uniform float logFactor;
void main(){vec2 uv=ndc*.5+.5;vec4 c=texture2D(colorMap,uv);if(c.a<.008)discard;
 vec2 sampleUv=(floor(uv/texel)+.5)*texel;
 float depth=texture2D(depthMap,sampleUv).r;if(depth>.999999)discard;
 // A neighbouring low-resolution depth belongs to a different ray. Comparing it
 // directly against terrain hides orbital clouds on Earth's curved surface.
 // Reconstruct its scattering altitude and intersect that shell on THIS ray.
 // Depth textures store normalized altitude, not logarithmic view depth.
 float radius=6378.137+depth*18.1-.01;
 vec3 eye=normalize((inverseProjection*vec4(ndc,1.,1.)).xyz),dir=normalize(cameraRotation*eye);
 float b=dot(cameraKm,dir),d=b*b-dot(cameraKm,cameraKm)+radius*radius;
 if(d<0.)discard;float t=-b-sqrt(d);if(t<0.)t=-b+sqrt(d);if(t<=0.)discard;
 gl_FragColor=vec4(c.rgb/max(c.a,.001),c.a);
 gl_FragDepthEXT=log2(1.+t*1000.*max(.001,-eye.z))*logFactor*.5;}
`
    });
    const mesh = new THREE.Mesh(geometry, composite);
    mesh.frustumCulled = false;
    let invalidTargets = false;
    let index = 0,
        valid = false,
        frames = 0;
    const lastSun = new THREE.Vector3(),
        lastProjection = new THREE.Matrix4(),
        lastRotation = new THREE.Matrix3(),
        lastCamera = new THREE.Vector3();
    return {
        mesh,
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
            composite.uniforms.colorMap.value = history[index].texture;
            composite.uniforms.depthMap.value = history[index].depthTexture;
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
            composite.dispose();
        }
    };
}
module.exports = { createReconstruction };
