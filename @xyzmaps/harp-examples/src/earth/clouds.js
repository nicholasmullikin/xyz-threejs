const Atmosphere = require("./atmosphere");
const { createReconstruction, cloudDepthGLSL } = require("./cloud-reconstruction");
const { createCloudReuse } = require("./cloud-reuse");
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
        draws: 0,
        reused: 0
    };
    const material = new THREE.ShaderMaterial({
        uniforms: {
            ...sky.uniforms,
            ...uniforms,
            cloudSteps: { value: 40 },
            cloudStepRefinement: { value: 0 },
            cloudLayerLighting: { value: false },
            cloudPixelAngle: { value: 0 },
            cloudBounds: { value: new THREE.Vector2(0.35, 14) },
            cloudCameraAltitude: { value: 0 }
        },
        transparent: !hasDepth,
        depthTest: true,
        depthWrite: hasDepth,
        extensions: { fragDepth: true },
        defines: { ATMOSPHERE_STEPS: 8, CLOUD_OFFSCREEN: hasDepth ? 1 : 0 },
        vertexShader,
        fragmentShader: `precision highp float;varying vec2 ndc;uniform float cloudSteps,cloudStepRefinement;uniform bool cloudLayerLighting;uniform float cloudCameraAltitude;uniform vec2 cloudBounds;uniform mat4 inverseProjection;uniform mat3 cameraRotation;
#include <logdepthbuf_pars_fragment>
${Atmosphere.glsl}
${environmentGLSL}
${densityGLSL}
${cloudDepthGLSL}
${require("./cloud-lighting").glsl}
vec3 cloudLightingAt(vec3 dir,vec2 moment,float sampleDistance,float opacity){
 vec3 p=cameraKm+dir*moment.x,up=normalize(p);
 float meanDensity=moment.y;
 float height=max(0.,length(p)-planetRadius);
 vec3 lightDir=cloudLightDirection(dot(up,sunDirection)+sqrt(2.*height/planetRadius));
 // Spread the second sample for the long slant paths near sunrise/sunset.
 float farStep=mix(3.6,2.1,smoothstep(.04,.55,abs(dot(up,lightDir))));
 float nearDensity=cloudDensity(p+lightDir*.55,sampleDistance);
 float farDensity=cloudDensity(p+lightDir*farStep,sampleDistance);
 float lightDepth=nearDensity*.85+farDensity*(farStep-.55);
 return cloudRadiance(p,dir,lightDir,meanDensity,nearDensity,lightDepth,opacity);
}
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
 // A ray that grazes the cloud base can see another part of the deck
 // beyond its closest approach. Keep the same outer-shell sample positions
 // across that tangent. Density vanishes in the clear gap between segments.
 vec2 inner=sphereInterval(cameraKm,dir,planetRadius+max(.1,cloudBounds.x*lowClimate-.1));
 if(inner.x>start){
  if(inner.y>=end)end=min(end,inner.x);
 }else if(inner.y>start)start=inner.y;
 if(end<=start||outer.y<0.)discard;
 // Bound the length of visible atmosphere traversed on a tangent.
 end=min(end,start+360.);
 
 // Keep each interval fixed as the image moves. A screen-space offset
 // stamps the half-resolution pixel lattice into thin cloud edges.
 float trans=1.,first=-1.,weight=0.,rearWeight=0.;
 vec2 scattering=vec2(0.),rearScattering=vec2(0.);
 float orbitalDensity=mix(1.,.65,smoothstep(100.,1000.,length(cameraKm)-planetRadius));
 // A regional deck varies much faster horizontally than vertically. Reuse its
 // properties along the ray, while evaluating the vertical profiles at every
 // integration sample. Fixed kilometre spacing avoids rings when the slant changes.
 float steps=cloudSteps;
 // Long slant paths can turn a single density sample into a bright shelf.
 // Subdivide only these intervals, continuously opening each new half-step
 // from zero width so crossing a quality boundary never shifts the whole ray.
 // Compare the unrefined step to the footprint of an actual cloud-pass
 // pixel. Keep sub-kilometre vertical profiles resolved even looking down.
 float meanStepKm=(end-start)/steps;
 float pixelKm=(start+.5*(end-start))*cloudPixelAngle;
 // Forecast cells can stack an 850 m stratus layer with higher cloud.
 // Its condensation ramp is about 150 m deep.
 float spacingKm=max(cloudPreset<-.5?.15:.30,pixelKm);
 float footprintRefinement=smoothstep(.55,2.,meanStepKm/spacingKm);
 float grazingRefinement=smoothstep(3.,14.,end-start)
     *(1.-smoothstep(.45,.80,abs(dot(dir,normalize(cameraKm)))))
     *(1.-smoothstep(22.,70.,cloudCameraAltitude));
 #if EARTH_REGIONAL_CLOUDS == 1
 // Cached columns already integrate the vertical profile at two points.
 footprintRefinement*=.5;
 #endif
 float slantRefinement=cloudStepRefinement*max(grazingRefinement,footprintRefinement);
 float split=0.;
 if(slantRefinement>0.){
  steps*=slantRefinement>1.?4.:2.;
  split=slantRefinement>1.?slantRefinement-1.:slantRefinement;
 }
 #if EARTH_REGIONAL_CLOUDS == 1
 bool useColumns=start>=35.;
 float columnStart=start,columnEnd=start,columnSpan=1.;
 vec4 leftColumn=vec4(1.,0.,0.,0.),rightColumn=leftColumn;
 if(useColumns){
  float slant=length(cross(dir,normalize(cameraKm+dir*((start+end)*.5))));
  // Regional weather also varies with height. A horizontal-only footprint
  // interpolates an entire deck between its top and base when viewed from above.
  // The vertically varying detail fades at long range; the broad bands remain.
  float verticalDetail=.60*(1.-smoothstep(180.,950.,start));
  columnSpan=max((end-start)/24.,2./max(.04,max(slant,verticalDetail)));
  columnEnd=min(end,start+columnSpan);
  leftColumn=sampleRegionalColumn(cameraKm+dir*start,start);
  rightColumn=sampleRegionalColumn(cameraKm+dir*columnEnd,columnEnd);
 }
 // At aircraft and regional zooms, the resolved cloud structure still
 // changes within each interval. Reserve step merging for the orbital LOD.
 float regionalBudget=smoothstep(180.,650.,cloudCameraAltitude)*smoothstep(25.,82.,start);
 #endif
 for(int i=0;i<256;i++){
  if(float(i)>=steps||trans<.015)break;
  float index=float(i),a=index/steps,b=(index+1.)/steps;
  if(slantRefinement>0.){
   if(mod(index,2.)<1.)b+=(1.-split)/steps;
   else a+=(1.-split)/steps;
  }
  #if EARTH_REGIONAL_CLOUDS == 1
  // Merge adjacent intervals on the original sample lattice. Changing the
  // step count slides every sample through the deck and flashes its opacity.
  // Keep one unpaired interval in each group of three at the low setting.
  float lane=mod(index,steps<32.?3.:2.);
  if(lane<.5&&index+1.<steps)b=mix(b,(index+2.)/steps,regionalBudget);
  else if(lane>.5&&lane<1.5){
   if(regionalBudget>.999)continue;
   a=mix(a,b,regionalBudget);
  }
  #endif
  float ta=start+(end-start)*a*a,tb=start+(end-start)*b*b;
  float stepSize=tb-ta,t=.5*(ta+tb);
  vec3 p=cameraKm+dir*t;float sampleDistance=max(t,stepSize*25.),density;
  #if EARTH_REGIONAL_CLOUDS == 1
  if(useColumns){
   // Long steps may cross more than one interval at low quality.
   if(t>columnEnd){
    float advance=floor((t-columnEnd)/columnSpan);
    columnStart=columnEnd+advance*columnSpan;
    leftColumn=advance<1.?rightColumn:sampleRegionalColumn(cameraKm+dir*columnStart,columnStart);
    columnEnd=min(end,columnStart+columnSpan);
    rightColumn=sampleRegionalColumn(cameraKm+dir*columnEnd,columnEnd);
   }
   float u=clamp((t-columnStart)/max(.001,columnEnd-columnStart),0.,1.);
   float climateAtPoint=cloudClimate(p);
   float h=(length(p)-planetRadius)/climateAtPoint;
   vec4 column=mix(leftColumn,rightColumn,u);
   // Two-point Gaussian quadrature of the vertical density profile resolves
   // thin layers between midpoints. Both nodes reuse the same weather column.
   float dh=.28867513*stepSize*dot(normalize(p),dir)/climateAtPoint;
   density=.5*(columnDensity(column,h-dh)+columnDensity(column,h+dh));
   float regional=regionalWeight(sampleDistance);
   if(regional<.999)density=mix(cloudDensity(p,sampleDistance),density,regional);
  }else
  #endif
  density=cloudDensity(p,sampleDistance);
  density*=orbitalDensity;
  if(density<.002)continue;
  float opacity=1.-exp(-density*stepSize);
  float w=trans*opacity;
  vec2 sampleMoment=vec2(t,density);
  scattering+=w*sampleMoment;
  if(cloudLayerLighting){
   // Split an interval proportionally if its opacity crosses the boundary.
   // Faint rays and capped devices use a single lighting evaluation.
   float rear=max(0.,w-max(0.,.4-weight));
   rearScattering+=rear*sampleMoment;
   rearWeight+=rear;
  }
  weight+=w;trans*=1.-opacity;
  // Thin ice-cloud samples can each be faint while their integrated opacity is
  // visible. Per-step thresholds made cirrus disappear as sample count rose.
  if(first<0.&&weight>.008){
   // Locate the opacity crossing within the interval. Using its midpoint
   // snaps the depth used for haze and reprojection by an entire step.
   float entering=max(.992,1.-(weight-w));
   first=ta+clamp(log(entering/.992)/density,0.,stepSize);
  }
 }
 if(weight<.008||first<0.)discard;
 // Light the front and rear scattering regions separately when both are
 // visible. One centroid can sit in a clear gap between separate decks.
 vec2 mean=scattering/weight;
 vec3 lighting;
 if(rearWeight>.001){
  vec2 front=(scattering-rearScattering)/(weight-rearWeight),back=rearScattering/rearWeight;
  float frontLOD=mix(first,front.x,smoothstep(.001,.025,rearWeight));
  lighting=mix(cloudLightingAt(dir,front,frontLOD,weight),
               cloudLightingAt(dir,back,back.x,weight),rearWeight/weight);
 }else{
  lighting=cloudLightingAt(dir,mean,first,weight);
 }
 vec3 transmission;vec3 haze=atmosphere(cameraKm,dir,first,transmission);
 vec3 color=displayColor(lighting*transmission+haze);
 #if CLOUD_OFFSCREEN == 1
 color*=weight;
 #endif
 gl_FragColor=vec4(color,weight);
 #if CLOUD_OFFSCREEN == 1
 // Store altitude rather than camera-distance depth. Even a 16-bit depth
 // texture then resolves sub-metre cloud heights in an orbital view.
 // Avoid subtracting two ~6378 km floats to recover a sub-metre altitude.
 float radialChange=(2.*dot(cameraKm,dir)*first+first*first)/(length(cameraKm+dir*first)+planetRadius+cloudCameraAltitude);
 gl_FragDepthEXT=encodeCloudDepth(cloudCameraAltitude+radialChange,dot(cameraKm,dir)+first);
 #elif defined(USE_LOGDEPTHBUF_EXT)
 gl_FragDepthEXT=log2(max(1e-6,1.+first*1000.*(-eyeDir.z)))*logDepthBufFC*.5;
 #endif
}`
    });
    const geometry = new THREE.PlaneGeometry(2, 2),
        volume = new THREE.Mesh(geometry, material);
    volume.frustumCulled = false;
    const cloudScene = new THREE.Scene();
    cloudScene.userData.earthPass = "cloudVolume";
    cloudScene.add(volume);
    const reconstruction = hasDepth
        ? createReconstruction(
              THREE,
              map,
              geometry,
              sky.uniforms,
              material.uniforms.cloudCameraAltitude
          )
        : undefined;
    const composite = reconstruction ? reconstruction.mesh : volume;
    const composites = reconstruction ? reconstruction.meshes : [volume];
    for (const [index, mesh] of composites.entries()) {
        mesh.renderOrder = 11000 + index;
        map.scene.add(mesh);
    }
    const size = new THREE.Vector2(),
        viewport = new THREE.Vector4(),
        scissor = new THREE.Vector4(),
        clearColor = new THREE.Color();
    const reuse = createCloudReuse();
    let disposed = false,
        wasEnabled = false,
        budgetLimit;
    function update(enabled) {
        if (disposed) return;
        if (enabled && !wasEnabled) {
            reconstruction?.reset();
            reuse.invalidate();
        }
        wasEnabled = enabled;
        if (!enabled) {
            for (const mesh of composites) mesh.visible = false;
            return;
        }
        // Reconstruction chooses the orbital or local composite set. Preserve
        // that choice on reused frames instead of enabling both sets at once.
        if (!reconstruction) volume.visible = true;
        if (renderer.getContext().isContextLost()) {
            status.contextLost = true;
            status.historyFrames = 0;
            return;
        }
        if (status.contextLost) {
            reconstruction?.invalidate();
            reuse.invalidate();
            status.contextLost = false;
            status.historyFrames = 0;
        }
        renderer.getDrawingBufferSize(size);
        const sceneScale =
            map.dynamicPixelRatio === undefined
                ? 1
                : Math.min(1, map.dynamicPixelRatio / map.pixelRatio);
        const budget = renderBudget(
            size.x * sceneScale,
            size.y * sceneScale,
            status.quality,
            hasDepth,
            budgetLimit
        );
        Object.assign(status, budget);
        material.uniforms.cloudSteps.value = budget.steps;
        const projection = map.camera.projectionMatrix.elements;
        material.uniforms.cloudPixelAngle.value = Math.max(
            2 / (budget.width * projection[0]), 2 / (budget.height * projection[5])
        );
        const adaptive = hasDepth && !budgetLimit && budget.steps >= 32;
        material.uniforms.cloudStepRefinement.value = adaptive ? 2 : 0;
        material.uniforms.cloudLayerLighting.value = adaptive;
        material.uniforms.cloudCameraAltitude.value =
            map.camera.position.length() * 0.001 - 6378.137;
        // The historical coverage map supplies a continuous column profile from
        // aircraft altitudes to the whole globe. Forecasts and preset genera
        // carry their own layer information.
        const altitude = material.uniforms.cloudCameraAltitude.value;
        const regional = uniforms.cloudPreset.value === 0 && altitude > 20 ? 1 : 0;
        if (material.defines.EARTH_REGIONAL_CLOUDS !== regional) {
            material.defines.EARTH_REGIONAL_CLOUDS = regional;
            material.needsUpdate = true;
        }
        if (!reconstruction) return;
        const now = performance.now(),
            state = {
                camera: sky.uniforms.cameraKm.value,
                rotation: sky.uniforms.cameraRotation.value,
                projection: map.camera.projectionMatrix,
                sun: sky.uniforms.sunDirection.value,
                time: uniforms.cloudTime.value,
                preset: uniforms.cloudPreset.value,
                coverage: uniforms.cloudMap.value,
                noise: uniforms.cloudNoise.value,
                width: budget.width,
                height: budget.height,
                steps: budget.steps
            };
        if (reuse.canReuse(state, now)) {
            status.reused++;
            return;
        }
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
            reuse.record(state, now);
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
            const p = presets.find(p => p.id === (id === -1 ? 0 : Number(id)));
            if (!p) return;
            uniforms.cloudPreset.value = Number(id);
            material.uniforms.cloudBounds.value.set(p.base, p.top);
            reconstruction?.reset();
            reuse.invalidate();
            status.historyFrames = 0;
            map.update();
        },
        setBudget(pixels, steps) {
            if (!(pixels > 0 && steps >= 8 && steps <= 64)) return;
            if (budgetLimit?.pixels === pixels && budgetLimit?.steps === steps) return;
            budgetLimit = { pixels, steps };
            reconstruction?.reset();
            reuse.invalidate();
            status.historyFrames = 0;
        },
        setQuality(name) {
            if (!quality[name]) return;
            status.quality = name;
            reconstruction?.reset();
            reuse.invalidate();
            status.historyFrames = 0;
            map.update();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const mesh of composites) map.scene.remove(mesh);
            cloudScene.remove(volume);
            geometry.dispose();
            material.dispose();
            reconstruction?.dispose();
        }
    };
}
module.exports = { createClouds };
