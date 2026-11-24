// Locally cached sunlight visibility. Daytime receivers can borrow their
// night-light sampler, preserving the number of fine imagery pages per draw.
const glsl = `
#ifdef EARTH_SUN_SHADOW
uniform mat4 localShadowMatrix;
uniform vec3 localShadowOrigin;
uniform vec2 localShadowSize;
uniform vec3 regionalSunOrigin;
uniform vec3 regionalSunEast;
uniform vec3 regionalSunSouth;
uniform float regionalSunEnabled;
float shadowTest(vec2 uv,float depth){
 uv.y*=localShadowSize.x/(localShadowSize.x+33.);
 vec2 rg=texture2D(nightMap,uv).rg;
 return step(depth,dot(rg,vec2(65280./65535.,255./65535.)));
}
float groundSun(vec3 worldKm,vec3 normal){
 float farLight=1.;
 if(regionalSunEnabled>.5){
   vec3 delta=worldKm-regionalSunOrigin;
   vec2 coord=vec2(dot(delta,regionalSunEast),dot(delta,regionalSunSouth))/32.+.5;
   float edge=max(abs(coord.x-.5),abs(coord.y-.5));
   if(edge<.5){
     vec2 atlas=(coord*32.+vec2(.5,localShadowSize.x+.5))/vec2(localShadowSize.x,localShadowSize.x+33.);
     vec2 packedHeight=texture2D(nightMap,atlas).rg;
     float blocker=dot(packedHeight,vec2(65280.,255.))*(12000./65535.)-2000.;
     float lit=smoothstep(-180.,80.,(length(worldKm)-planetRadius)*1000.-blocker);
     farLight=mix(lit,1.,smoothstep(.40,.50,edge));
   }
 }
 float texel=localShadowSize.y;
 vec3 relative=(worldKm-localShadowOrigin)*1000.+normal*(.45+.35*texel);
 vec3 p=(localShadowMatrix*vec4(relative,1.)).xyz*.5+.5;
 float edge=max(max(abs(p.x-.5),abs(p.y-.5)),abs(p.z-.5));
 if(edge>=.498)return farLight;
 float bias=(.38+.60*texel*(1.-abs(dot(normal,sunDirection))))/9000.;
 vec2 grid=p.xy*localShadowSize.x-.5,uv=(floor(grid)+.5)/localShadowSize.x,f=fract(grid);
 vec2 stepUv=vec2(1./localShadowSize.x,0.);
 float d=p.z-bias;
 float light=mix(mix(shadowTest(uv,d),shadowTest(uv+stepUv.xy,d),f.x),
                 mix(shadowTest(uv+stepUv.yx,d),shadowTest(uv+stepUv.xx,d),f.x),f.y);
 return min(farLight,mix(light,1.,smoothstep(.40,.49,edge)));
}
#endif
`;
function createShadows(THREE, map, sky, elevation, lowMemory) {
    const stats = {
        enabled: false,
        active: false,
        renders: 0,
        casters: 0,
        receivers: 0,
        regional: false,
        regionalUpdates: 0,
        regionalBytes: 0
    };
    const regional = require("./regional-shadows").createRegionalShadows(THREE, map, stats);
    const resolution = lowMemory ? 768 : 1024;
    const light = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 9001);
    const scene = new THREE.Scene(),
        proxies = new WeakMap(),
        bound = new Map();
    scene.userData.earthPass = "localShadows";
    const atlas = { value: null },
        matrix = { value: new THREE.Matrix4() },
        origin = { value: new THREE.Vector3() },
        size = { value: new THREE.Vector2() };
    const uniforms = {
        localShadowMatrix: matrix,
        localShadowOrigin: origin,
        localShadowSize: size,
        ...regional.uniforms
    };
    const lastFocus = new THREE.Vector3(),
        lastSun = new THREE.Vector3(),
        focus = new THREE.Vector3(),
        radial = new THREE.Vector3(),
        diff = new THREE.Vector3();
    const casterOrigin = { value: new THREE.Vector3() };
    const terrainSourceScale = { value: 0 };
    const makeCaster = urban =>
        new THREE.ShaderMaterial({
            uniforms: { casterOrigin, terrainSourceScale },
            side: THREE.DoubleSide,
            vertexShader: urban
                ? `uniform vec3 casterOrigin;attribute float foundationHeight;
        attribute vec2 tileUv;varying vec2 boundaryUv;
        void main(){boundaryUv=tileUv/${require("./building-coordinates").SCALE}.+.5;
        vec3 p=position+normalize(casterOrigin+position)*(foundationHeight*10000.-999.5);
        gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`
                : `attribute float terrainSourceOffset;uniform float terrainSourceScale;
        void main(){vec3 p=position;p.z+=terrainSourceOffset*terrainSourceScale;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
            fragmentShader: `${urban ? "varying vec2 boundaryUv;" : ""}
        void main(){${urban ? "if(any(lessThan(boundaryUv,vec2(0.)))||any(greaterThan(boundaryUv,vec2(1.))))discard;" : ""}
        float z=floor(clamp(gl_FragCoord.z,0.,1.)*65535.+.5);
        gl_FragColor=vec4(floor(z/256.)/255.,mod(z,256.)/255.,0.,1.);}`
        });
    let terrainCaster,
        buildingCaster,
        target,
        timer,
        lastDraw = -Infinity,
        lastHash,
        lastRange,
        disposed = false;
    const renderer = map.renderer,
        viewport = new THREE.Vector4(),
        scissor = new THREE.Vector4(),
        color = new THREE.Color();
    function unbind(mat) {
        mat.uniforms.nightMap = bound.get(mat);
        bound.delete(mat);
        delete mat.defines.EARTH_SUN_SHADOW;
        mat.needsUpdate = true;
    }
    function clear() {
        clearTimeout(timer);
        timer = undefined;
        regional.reset();
        for (const mat of bound.keys()) unbind(mat);
        target?.dispose();
        target = undefined;
        atlas.value = null;
        lastHash = undefined;
        lastDraw = -Infinity;
        stats.active = false;
        stats.casters = stats.receivers = 0;
    }
    function draw(items, range, up) {
        if (!target) {
            target = new THREE.WebGLRenderTarget(resolution, resolution + 33, {
                depthBuffer: true,
                stencilBuffer: false,
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter
            });
            target.viewport.set(0, 0, resolution, resolution);
            target.scissor.copy(target.viewport);
            target.scissorTest = true;
            target.texture.generateMipmaps = false;
            atlas.value = target.texture;
        }
        terrainCaster ??= makeCaster(false);
        buildingCaster ??= makeCaster(true);
        light.left = light.bottom = -range;
        light.right = light.top = range;
        light.position.copy(sky.uniforms.sunDirection.value).multiplyScalar(4500);
        // The local vertical becomes a poor camera-up vector near solar noon
        // in the tropics. Use a tangent in that small polar cap.
        if (Math.abs(up.dot(sky.uniforms.sunDirection.value)) > 0.98)
            light.up.set(-up.y, up.x, 0).normalize();
        else light.up.copy(up);
        light.lookAt(0, 0, 0);
        light.updateProjectionMatrix();
        light.updateMatrixWorld();
        matrix.value.multiplyMatrices(light.projectionMatrix, light.matrixWorldInverse);
        origin.value.copy(focus).multiplyScalar(0.001);
        size.value.set(resolution, (2 * range) / resolution);
        for (const { mesh, tile, urban } of items) {
            let copy = proxies.get(mesh);
            if (!copy) {
                copy = new THREE.Mesh(mesh.geometry, urban ? buildingCaster : terrainCaster);
                copy.onBeforeRender = () => {
                    if (urban) {
                        casterOrigin.value.copy(tile.center);
                        buildingCaster.uniformsNeedUpdate = true;
                    } else {
                        terrainSourceScale.value =
                            mesh.material.uniforms.terrainSourceScale?.value || 0;
                        terrainCaster.uniformsNeedUpdate = true;
                    }
                };
                proxies.set(mesh, copy);
            }
            copy.geometry = mesh.geometry;
            copy.position.copy(tile.center).sub(focus);
            if (mesh.displacement) copy.position.add(mesh.displacement);
            if (tile.localTangentSpace)
                copy.setRotationFromMatrix(tile.boundingBox.getRotationMatrix());
            scene.add(copy);
        }
        const old = renderer.getRenderTarget(),
            alpha = renderer.getClearAlpha(),
            auto = renderer.autoClear,
            scissorTest = renderer.getScissorTest();
        renderer.getViewport(viewport);
        renderer.getScissor(scissor);
        renderer.getClearColor(color);
        try {
            renderer.autoClear = true;
            renderer.setScissorTest(false);
            renderer.setClearColor(0xffffff, 1);
            renderer.setRenderTarget(target);
            renderer.render(scene, light);
        } finally {
            scene.clear();
            renderer.setRenderTarget(old);
            renderer.setViewport(viewport);
            renderer.setScissor(scissor);
            renderer.setScissorTest(scissorTest);
            renderer.setClearColor(color, alpha);
            renderer.autoClear = auto;
        }
    }
    function update(entries, mode) {
        if (!stats.enabled || disposed) return;
        const cam = map.camera.position,
            camGeo = map.projection.unprojectPoint(cam),
            altitude = cam.length() - 6378137;
        const ground = altitude < 12000 ? elevation(camGeo) : 0;
        radial.copy(cam).normalize();
        const sun = sky.uniforms.sunDirection.value;
        if (
            mode !== "a" ||
            document.hidden ||
            altitude - ground > 3600 ||
            radial.dot(sun) < 0.035 ||
            renderer.getContext().isContextLost()
        ) {
            clear();
            return;
        }
        regional.update(camGeo, sun);
        const range = altitude - ground > 600 ? 2304 : 1152;
        focus.copy(radial).multiplyScalar(6378137 + ground);
        map.camera.getWorldDirection(diff);
        diff.addScaledVector(radial, -diff.dot(radial));
        focus.addScaledVector(diff, range * 0.27);
        const items = [],
            materials = new Set();
        let hash = 2166136261;
        for (const entry of entries) {
            const kind = entry.dataSource.name,
                urban = kind === "buildings";
            if (!urban && kind !== "terrain") continue;
            for (const tile of entry.renderedTiles.values()) {
                const radius = tile.boundingBox?.extents?.length() || 0;
                if (tile.tileKey.level < 10) continue;
                const nearby = tile.center.distanceTo(focus) <= range * 2.5 + radius;
                const distant = regional.covers(tile.tileKey);
                if (!nearby && !distant) continue;
                for (const mesh of tile.objects) {
                    if (!mesh.isMesh || !mesh.visible || !mesh.material?.uniforms?.nightMap)
                        continue;
                    const mat = mesh.material;
                    materials.add(mat);
                    if (!nearby) continue;
                    items.push({ mesh, tile, urban });
                    const morphStep = Math.round(
                        (mesh.geometry.userData.terrainTransition?.factor || 0) * 8
                    );
                    hash = Math.imul(
                        hash ^
                            (mesh.geometry.id +
                                31 * (mesh.geometry.attributes.foundationHeight?.version || 0) +
                                127 * morphStep),
                        16777619
                    );
                }
            }
        }
        if (!items.length) {
            if (target) clear();
            return;
        }
        const moved = lastFocus.distanceTo(focus),
            now = performance.now();
        if (
            !target ||
            hash !== lastHash ||
            moved > range * 0.14 ||
            range !== lastRange ||
            sun.dot(lastSun) < 0.999982
        ) {
            const delay = (map.cameraIsMoving ? 400 : 220) - (now - lastDraw);
            if (delay <= 0 || !target || moved > range) {
                draw(items, range, radial);
                lastFocus.copy(focus);
                lastSun.copy(sun);
                lastRange = range;
                lastHash = hash;
                lastDraw = now;
                stats.renders++;
                stats.casters = items.length;
            } else if (timer === undefined) {
                timer = setTimeout(() => {
                    timer = undefined;
                    if (!disposed) map.update();
                }, delay + 1);
            }
        }
        regional.upload(renderer, target, resolution);
        for (const mat of bound.keys()) if (!materials.has(mat)) unbind(mat);
        for (const mat of materials)
            if (!bound.has(mat)) {
                bound.set(mat, mat.uniforms.nightMap);
                Object.assign(mat.uniforms, uniforms);
                mat.uniforms.nightMap = atlas;
                mat.defines.EARTH_SUN_SHADOW = 1;
                mat.needsUpdate = true;
            }
        stats.active = true;
        stats.receivers = materials.size;
    }
    map.canvas.addEventListener("webglcontextlost", clear);
    return {
        stats,
        update,
        setEnabled(on) {
            if (stats.enabled === on) return;
            stats.enabled = !!on;
            if (!on) clear();
            map.update();
        },
        dispose() {
            disposed = true;
            map.canvas.removeEventListener("webglcontextlost", clear);
            clear();
            terrainCaster?.dispose();
            buildingCaster?.dispose();
        }
    };
}
module.exports = { createShadows, glsl };
