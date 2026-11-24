// Low-resolution local tangent plane. Use already resident terrain and building
// geometry, never request imagery or terrain solely for a reflection.
const { renderTo } = require("./water-reflections");
function planarProbe(THREE, map, sky, water, elevation, environment) {
    const uniform = value => ({ value });
    const uniforms = {
        waterScene: uniform(null),
        waterSceneReady: uniform(0),
        waterDiskVisibility: uniform(new THREE.Vector2(1, 1)),
        waterProjection: uniform(new THREE.Matrix4()),
        waterOrigin: uniform(new THREE.Vector3()),
        waterPlaneUp: uniform(new THREE.Vector3())
    };
    const stats = { draws: 0, bytes: 0, casters: 0, height: 0 };
    const scene = new THREE.Scene(),
        camera = new THREE.PerspectiveCamera(),
        proxies = new WeakMap();
    scene.userData.earthPass = "waterShore";
    const captures = new Map(),
        reflectedEye = uniform(new THREE.Vector3());
    function facadeCapture(source) {
        let result = captures.get(source);
        if (!result) {
            result = new THREE.ShaderMaterial({
                vertexShader: source.vertexShader,
                fragmentShader: source.fragmentShader,
                vertexColors: true,
                extensions: { ...source.extensions },
                side: THREE.DoubleSide,
                defines: { ...source.defines, EARTH_WATER_CAPTURE: 1 },
                uniforms: {
                    ...source.uniforms,
                    waterOrigin: uniforms.waterOrigin,
                    waterPlaneUp: uniforms.waterPlaneUp,
                    cameraKm: reflectedEye
                }
            });
            captures.set(source, result);
            source.addEventListener("dispose", release);
        }
        return result;
    }
    function release(event) {
        const source = event.target;
        source.removeEventListener("dispose", release);
        captures.get(source)?.dispose();
        captures.delete(source);
    }
    // A virtual camera below a lake can see the underside of coarse DEM triangles.
    // Only the outward-facing surface can reflect into the lake.
    const ground = new THREE.ShaderMaterial({
        side: THREE.FrontSide,
        defines: { ATMOSPHERE_STEPS: 4 },
        extensions: { fragDepth: true },
        uniforms: {
            ...sky.uniforms,
            ...environment.uniforms,
            waterOrigin: uniforms.waterOrigin,
            cameraKm: reflectedEye,
            planeUp: uniforms.waterPlaneUp,
            scale: uniform(0),
            fallbackDepth: uniform(1),
            photo: uniform(null),
            waterMask: uniform(null),
            maskTransform: uniform(new THREE.Vector4()),
            hasWaterMask: uniform(0),
            photoUv: uniform(new THREE.Vector4()),
            useOverview: uniform(0)
        },
        vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 local,n;varying vec2 tex;uniform float scale,fallbackDepth;attribute float terrainSourceOffset;
void main(){
 vec3 p=position;p.z+=terrainSourceOffset*scale;
 tex=uv;local=(modelMatrix*vec4(p,1.)).xyz;n=mat3(modelMatrix)*normal;
 vec4 eye=viewMatrix*vec4(local,1.);eye.xyz*=fallbackDepth;
 gl_Position=projectionMatrix*eye;
 #include <logdepthbuf_vertex>
}`,
        fragmentShader: `precision highp float;
#include <logdepthbuf_pars_fragment>
${require("./atmosphere").glsl}
${require("./environment").glsl}
uniform vec3 planeUp,waterOrigin;uniform float useOverview;uniform sampler2D photo;uniform vec4 photoUv;
uniform sampler2D waterMask;uniform vec4 maskTransform;uniform float hasWaterMask;
varying vec3 local,n;varying vec2 tex;
void main(){
 vec2 maskUv=tex*maskTransform.xy+maskTransform.zw;
 if(dot(local,planeUp)<5. && hasWaterMask>.5 && all(greaterThanEqual(maskUv,vec2(0.))) && all(lessThan(maskUv,vec2(1.))) && texture2D(waterMask,maskUv*vec2(1.,1024./1154.)).r>.5) discard;
 if(dot(local,planeUp)<-.5 || dot(local,local)>625000000.)discard;
 #include <logdepthbuf_fragment>
 
 vec3 p=waterOrigin+local*.001,radial=normalize(p),normal=normalize(n);
 vec2 globalUv=vec2(atan(radial.y,radial.x)/6.2831853+.5,asin(clamp(radial.z,-1.,1.))/3.14159265+.5);
 vec3 albedo=texture2D(photo,mix(tex*photoUv.xy+photoUv.zw,globalUv,useOverview)).rgb;
 float day=dot(radial,sunDirection);
 vec3 direct=sunlight(p)*cloudShadow(p);
 vec3 illumination=surfaceAmbient(radial,normal,day,vec3(.025)+vec3(.28,.34,.43)*smoothstep(-.12,.18,day))
     +direct*(.45+.55*max(dot(normal,sunDirection),0.))*smoothstep(-.03,.06,day);
 vec3 light=photographicReflectance(pow(max(albedo,vec3(0.)),vec3(2.2)),day)*illumination;
 // Negative mirrored-camera altitudes are virtual. Apply the short air
 // segment from the water surface to the real shoreline above it.
 vec3 air;float km=length(local)*.001;
 vec3 haze=aerialPerspective(waterOrigin,normalize(local),km,air);
 light=max(vec3(0.),light*air+haze);
 gl_FragColor=vec4(sqrt(light/(1.+light)),.5+.5*clamp(log2(max(1.,1./gl_FragCoord.w))/13.,0.,1.));
}`
    });
    ground.defaultAttributeValues.terrainSourceOffset = [0];
    const lakeSample = new THREE.Vector2();
    const forward = new THREE.Vector3(),
        up = new THREE.Vector3();
    const eye = new THREE.Vector3(),
        center = new THREE.Vector3(),
        lastForward = new THREE.Vector3();
    const lastSun = new THREE.Vector3(),
        lastEye = new THREE.Vector3(),
        lastCenter = new THREE.Vector3();
    let target,
        inspectAfter = -Infinity,
        lastHash,
        lastProjection,
        lastAspect;
    function update(entries, on, now) {
        const main = map.camera,
            focus = map.worldTarget;
        if (!on || map.targetDistance > 6500 || document.hidden) {
            uniforms.waterSceneReady.value = 0;
            return;
        }
        if (uniforms.waterSceneReady.value && now < inspectAfter) return;
        inspectAfter = now + (map.cameraIsMoving ? 180 : 400);
        main.getWorldDirection(forward);
        const items = [];
        let hash = 0;
        for (const entry of entries) {
            const urban = entry.dataSource.name === "buildings";
            if (!urban && entry.dataSource.name !== "terrain") continue;
            const visible = new Set(entry.renderedTiles.values());
            const tiles = [...visible];
            if (!urban) {
                // The mirrored camera sees hills outside the normal view. Retain
                // resident coarse parents behind the visible cut to cover them.
                map.visibleTileSet.forEachCachedTile(tile => {
                    if (
                        tile.tileKey.level >= 7 &&
                        tile.tileKey.level <= 11 &&
                        !visible.has(tile) &&
                        !tile.disposed &&
                        tile.objects.length
                    )
                        tiles.push(tile);
                }, entry.dataSource);
            }
            for (const tile of tiles) {
                if (
                    tile.tileKey.level < (urban ? 10 : 7) ||
                    tile.center.distanceTo(focus) >
                        (urban ? 6200 : 25000) + (tile.boundingBox?.extents?.length() || 0)
                )
                    continue;
                for (const mesh of tile.objects) {
                    if (!mesh.visible || !mesh.isMesh || !mesh.material?.uniforms?.nightMap)
                        continue;
                    if (urban && !mesh.geometry.attributes.foundationHeight) continue;
                    if (!urban && (!mesh.geometry.attributes.uv || mesh.material.userData.openSea))
                        continue;
                    items.push({ tile, mesh, urban, fallback: !visible.has(tile) });
                    hash = Math.imul(
                        hash ^
                            mesh.geometry.id ^
                            ((mesh.material.uniforms.toMap?.value?.id || 0) * 31),
                        16777619
                    );
                }
            }
        }
        if (!items.length) {
            uniforms.waterSceneReady.value = 0;
            return;
        }
        const projection = main.projectionMatrix.elements[5];
        if (
            uniforms.waterSceneReady.value &&
            lastCenter.distanceToSquared(focus) < 0.25 &&
            lastEye.distanceToSquared(main.position) < 0.25 &&
            forward.dot(lastForward) > 0.999995 &&
            lastSun.dot(sky.uniforms.sunDirection.value) > 0.99999 &&
            hash === lastHash &&
            lastProjection === projection &&
            lastAspect === main.aspect
        )
            return;
        if (!target) {
            target = new THREE.WebGLRenderTarget(512, 320, {
                depthBuffer: true,
                stencilBuffer: false,
                minFilter: THREE.LinearFilter,
                magFilter: THREE.LinearFilter
            });
            uniforms.waterScene.value = target.texture;
        }
        center.copy(focus);
        const surfaceHeight = water.nearbyLevel(map.target, elevation, lakeSample);
        if (surfaceHeight === undefined) {
            uniforms.waterSceneReady.value = 0;
            return;
        }
        center.setLength(6378137 + surfaceHeight);
        stats.height = surfaceHeight;
        const visibility = require("./water-horizon").diskVisibility;
        stats.sunVisibility = visibility(
            lakeSample.x,
            lakeSample.y,
            surfaceHeight,
            sky.uniforms.sunDirection.value,
            elevation.atMercator
        );
        stats.moonVisibility = visibility(
            lakeSample.x,
            lakeSample.y,
            surfaceHeight,
            sky.uniforms.moonDirection.value,
            elevation.atMercator
        );
        uniforms.waterDiskVisibility.value.set(stats.sunVisibility, stats.moonVisibility);
        up.copy(center).normalize();
        uniforms.waterPlaneUp.value.copy(up);
        uniforms.waterOrigin.value.copy(center).multiplyScalar(0.001);
        eye.copy(main.position).sub(center);
        if (eye.dot(up) <= 1) {
            uniforms.waterSceneReady.value = 0;
            return;
        }
        lastForward.copy(forward);
        camera.position.copy(eye).reflect(up);
        camera.up.set(0, 1, 0).applyQuaternion(main.quaternion).reflect(up);
        camera.lookAt(forward.reflect(up).add(camera.position));
        reflectedEye.value.copy(center).add(camera.position).multiplyScalar(0.001);
        camera.near = main.near;
        camera.far = main.far;
        camera.projectionMatrix.copy(main.projectionMatrix);
        // Keep useful geometry just outside the displayed frame in the
        // reflection, including rays displaced sideways by ripples.
        camera.projectionMatrix.elements[0] *= 0.76;
        camera.projectionMatrix.elements[5] *= 0.76;
        camera.updateMatrixWorld();
        uniforms.waterProjection.value.multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse
        );
        for (const { tile, mesh, urban, fallback } of items) {
            let proxy = proxies.get(mesh);
            const mat = urban ? facadeCapture(mesh.material) : ground;
            if (!proxy) {
                proxy = new THREE.Mesh(mesh.geometry, mat);
                proxy.onBeforeRender = () => {
                    const u = mat.uniforms,
                        original = mesh.material.uniforms;
                    if (urban) {
                        if (original.nightMap) u.nightMap = original.nightMap;
                        const usesShadow = !!mesh.material.defines.EARTH_SUN_SHADOW;
                        if (usesShadow !== !!mat.defines.EARTH_SUN_SHADOW) {
                            if (usesShadow) {
                                mat.defines.EARTH_SUN_SHADOW = 1;
                                Object.assign(u, original, {
                                    waterOrigin: uniforms.waterOrigin,
                                    waterPlaneUp: uniforms.waterPlaneUp,
                                    cameraKm: reflectedEye
                                });
                            } else delete mat.defines.EARTH_SUN_SHADOW;
                            mat.needsUpdate = true;
                        }
                    }
                    if (!urban) {
                        u.fallbackDepth.value = proxy.userData.fallback ? 1.45 : 1;
                        u.scale.value = original.terrainSourceScale?.value || 0;
                        u.hasWaterMask.value =
                            mesh.material.defines.EARTH_MAPPED_WATER && original.mappedWater?.value
                                ? 1
                                : 0;
                        u.waterMask.value = original.mappedWater?.value || null;
                        if (original.waterUv) u.maskTransform.value.copy(original.waterUv.value);
                        u.photo.value = original.toMap.value;
                        u.photoUv.value.copy(original.toUv.value);
                        u.useOverview.value = original.toBase.value;
                    }
                    mat.uniformsNeedUpdate = true;
                };
                proxies.set(mesh, proxy);
            }
            proxy.userData.fallback = fallback;
            proxy.geometry = mesh.geometry;
            proxy.position.copy(tile.center).sub(center);
            if (mesh.displacement) proxy.position.add(mesh.displacement);
            if (tile.localTangentSpace)
                proxy.setRotationFromMatrix(tile.boundingBox.getRotationMatrix());
            scene.add(proxy);
        }
        try {
            renderTo(map.renderer, target, scene, camera, THREE);
        } finally {
            scene.clear();
        }
        stats.draws++;
        stats.bytes = 512 * 320 * 6;
        stats.casters = items.length;
        uniforms.waterSceneReady.value = 1;
        lastEye.copy(main.position);
        lastCenter.copy(center);
        lastSun.copy(sky.uniforms.sunDirection.value);
        lastHash = hash;
        lastProjection = projection;
        lastAspect = main.aspect;
    }
    const restored = () => {
        uniforms.waterSceneReady.value = 0;
        map.update();
    };
    map.canvas.addEventListener("webglcontextrestored", restored);
    return {
        uniforms,
        stats,
        update,
        dispose() {
            map.canvas.removeEventListener("webglcontextrestored", restored);
            target?.dispose();
            ground.dispose();
            for (const source of captures.keys()) release({ target: source });
        }
    };
}
module.exports = { planarProbe };
