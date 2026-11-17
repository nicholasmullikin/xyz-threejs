const Atmosphere = require("./atmosphere");
const { createReconstruction } = require("./cloud-reconstruction");
const { densityGLSL, renderBudget, presets, quality } = require("./cloud-model");
const vertexShader =
    "varying vec2 ndc;void main(){ndc=position.xy;gl_Position=vec4(position.xy,1.,1.);}";
function createClouds(THREE, map, sky, uniforms, environmentGLSL) {
    const renderer = map.renderer;
    const hasDepth =
        renderer.capabilities.isWebGL2 ||
        (renderer.extensions.has("WEBGL_depth_texture") &&
            renderer.extensions.has("EXT_frag_depth"));
    const status = {
        quality: "balanced",
        steps: 40,
        width: 1,
        height: 1,
        lowResolution: hasDepth,
        contextLost: false,
        historyFrames: 0,
        draws: 0
    };
    const material = new THREE.ShaderMaterial({
        uniforms: {
            ...sky.uniforms,
            ...uniforms,
            cloudSteps: { value: 40 },
            cloudBounds: { value: new THREE.Vector2(0.35, 14) },
            cloudFrame: { value: 0 }
        },
        transparent: !hasDepth,
        depthTest: true,
        depthWrite: hasDepth,
        extensions: { fragDepth: true },
        defines: { ATMOSPHERE_STEPS: 8, CLOUD_OFFSCREEN: hasDepth ? 1 : 0 },
        vertexShader,
        fragmentShader: `precision highp float;varying vec2 ndc;uniform float cloudSteps;uniform float cloudFrame;uniform vec2 cloudBounds;uniform mat4 inverseProjection;uniform mat3 cameraRotation;
#include <logdepthbuf_pars_fragment>
${Atmosphere.glsl}
${environmentGLSL}
${densityGLSL}
float phaseHG(float mu,float g){return (1.-g*g)/pow(max(.05,1.+g*g-2.*g*mu),1.5);}
void main(){
 if(cloudsEnabled<.5)discard;
 vec4 view=inverseProjection*vec4(ndc,1.,1.);vec3 eyeDir=normalize(view.xyz),dir=normalize(cameraRotation*eyeDir);
 float climate=cloudClimate(cameraKm);
 // Bound latitude changes across the visible horizon. Local views keep tight
 // bounds; orbital/polar views conservatively include the whole troposphere.
 float margin=.025+.4*acos(clamp(planetRadius/(max(planetRadius,length(cameraKm))+18.),0.,1.));
 float lowClimate=max(.72,climate-margin),highClimate=min(1.22,climate+margin);
 vec2 outer=sphereInterval(cameraKm,dir,planetRadius+cloudBounds.y*highClimate+.1);
 float start=max(0.,outer.x),end=outer.y;
 vec2 ground=sphereInterval(cameraKm,dir,planetRadius);
 if(ground.x>0.)end=min(end,ground.x);
 // A shell interval excludes Earth's interior, including the far side beneath us.
 vec2 inner=sphereInterval(cameraKm,dir,planetRadius+max(.1,cloudBounds.x*lowClimate-.1));
 if(inner.x>start)end=min(end,inner.x);
 else if(inner.y>start)start=inner.y;
 if(end<=start||outer.y<0.)discard;
 // Long tangent rays use the same finite work budget as overhead views.
 end=min(end,start+360.);
 
 float jitter=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))+cloudFrame*.754877666));
 float trans=1.,first=-1.,weight=0.;vec3 weighted=vec3(0.);
 for(int i=0;i<64;i++){
  if(float(i)>=cloudSteps||trans<.015)break;
  float a=float(i)/cloudSteps,b=(float(i)+1.)/cloudSteps;
  float ta=start+(end-start)*a*a,tb=start+(end-start)*b*b;
  float stepSize=tb-ta,t=mix(ta,tb,.15+jitter*.7);
  vec3 p=cameraKm+dir*t;float density=cloudDensity(p,max(t,stepSize*25.));
  if(density<.002)continue;
  float opacity=1.-exp(-density*stepSize);
  float w=trans*opacity;weighted+=p*w;weight+=w;trans*=1.-opacity;
  // Thin ice-cloud samples can each be faint while their integrated opacity is
  // visible. Per-step thresholds made cirrus disappear as sample count rose.
  if(first<0.&&weight>.008)first=t;
 }
 if(weight<.008||first<0.)discard;
 vec3 p=weighted/max(weight,.001),n=normalize(p);
 float day=dot(n,sunDirection),height=(length(p)-planetRadius)/cloudClimate(p);
 // Two cone-like light probes replace a secondary march at every view sample.
 float lightDepth=cloudDensity(p+sunDirection*.7,first)*.7+cloudDensity(p+sunDirection*2.4,first)*1.7;
 float direct=exp(-lightDepth*1.1),multiple=exp(-lightDepth*.23)*.35;
 float mu=dot(dir,sunDirection),phase=.78*phaseHG(mu,.62)+.22*phaseHG(mu,-.22);
 float powder=1.-exp(-weight*3.);
 float skyFill=mix(.13,.35,smoothstep(.5,12.,height));
 vec3 ambient=vec3(.38,.51,.72)*skyFill;
 vec3 lighting=ambient+sunlight(p)*(direct*(.28+phase*.22)+multiple*powder)*smoothstep(-.12,.10,day);
 lighting*=mix(.32,1.,smoothstep(-.20,.02,day));
 lighting+=vec3(.0015,.0022,.004);
 vec3 transmission;vec3 haze=atmosphere(cameraKm,dir,first,transmission);
 vec3 color=displayColor(lighting*transmission+haze);
 #if CLOUD_OFFSCREEN == 1
 color*=weight;
 #endif
 gl_FragColor=vec4(color,weight);
 #if CLOUD_OFFSCREEN == 1
 // Store altitude rather than camera-distance depth. Even a 16-bit depth
 // texture then resolves sub-metre cloud heights in an orbital view.
 gl_FragDepthEXT=(length(cameraKm+dir*first)-planetRadius+.01)/18.1;
 #elif defined(USE_LOGDEPTHBUF_EXT)
 gl_FragDepthEXT=log2(max(1e-6,1.+first*1000.*(-eyeDir.z)))*logDepthBufFC*.5;
 #endif
}`
    });
    const geometry = new THREE.PlaneGeometry(2, 2),
        volume = new THREE.Mesh(geometry, material);
    volume.frustumCulled = false;
    const cloudScene = new THREE.Scene();
    cloudScene.add(volume);
    const reconstruction = hasDepth
        ? createReconstruction(THREE, map, geometry, sky.uniforms)
        : undefined;
    const composite = reconstruction ? reconstruction.mesh : volume;
    composite.renderOrder = 11000;
    map.scene.add(composite);
    const size = new THREE.Vector2(),
        viewport = new THREE.Vector4(),
        scissor = new THREE.Vector4(),
        clearColor = new THREE.Color();
    let disposed = false;
    function update(enabled) {
        if (disposed) return;
        if (enabled && !composite.visible) reconstruction?.reset();
        composite.visible = enabled;
        if (!enabled) return;
        if (renderer.getContext().isContextLost()) {
            status.contextLost = true;
            status.historyFrames = 0;
            return;
        }
        if (status.contextLost) {
            reconstruction?.invalidate();
            status.contextLost = false;
            status.historyFrames = 0;
        }
        renderer.getDrawingBufferSize(size);
        const budget = renderBudget(size.x, size.y, status.quality, hasDepth);
        Object.assign(status, budget);
        material.uniforms.cloudSteps.value = budget.steps;
        if (!reconstruction) return;
        material.uniforms.cloudFrame.value = (material.uniforms.cloudFrame.value + 1) % 1024;
        // Render before MapView's main pass, avoiding nested renderer calls. Restore
        // all modified framebuffer/clear/viewport state for the owning renderer.
        const previous = renderer.getRenderTarget(),
            autoClear = renderer.autoClear,
            alpha = renderer.getClearAlpha(),
            scissorTest = renderer.getScissorTest();
        renderer.getViewport(viewport);
        renderer.getScissor(scissor);
        renderer.getClearColor(clearColor);
        try {
            renderer.setScissorTest(false);
            renderer.setClearColor(0, 0);
            renderer.autoClear = true;
            reconstruction.render(renderer, cloudScene, budget.width, budget.height);
            status.draws += 2;
            status.historyFrames = reconstruction.frames;
        } finally {
            renderer.setRenderTarget(previous);
            renderer.setViewport(viewport);
            renderer.setScissor(scissor);
            renderer.setScissorTest(scissorTest);
            renderer.setClearColor(clearColor, alpha);
            renderer.autoClear = autoClear;
        }
    }
    return {
        mesh: composite,
        status,
        update,
        presets,
        setPreset(id) {
            if (!presets.some(p => p.id === Number(id))) return;
            uniforms.cloudPreset.value = Number(id);
            const p = presets.find(p => p.id === Number(id));
            material.uniforms.cloudBounds.value.set(p.base, p.top);
            reconstruction?.reset();
            status.historyFrames = 0;
            map.update();
        },
        setQuality(name) {
            if (!quality[name]) return;
            status.quality = name;
            reconstruction?.reset();
            status.historyFrames = 0;
            map.update();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            map.scene.remove(composite);
            cloudScene.remove(volume);
            geometry.dispose();
            material.dispose();
            reconstruction?.dispose();
        }
    };
}
module.exports = { createClouds };
