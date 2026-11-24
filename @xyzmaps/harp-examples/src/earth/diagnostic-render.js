const { providers, providerOf } = require("./terrain-providers");
// Draw an isolated diagnostic pass after the map frame. Proxy objects borrow
// geometry and instance attributes without changing production materials.
function diagnosticRender(THREE, map) {
    const scene = new THREE.Scene(),
        camera = new THREE.PerspectiveCamera(),
        proxies = new WeakMap();
    const shader = new THREE.ShaderMaterial({
        uniforms: {
            offset: { value: 0 },
            color: { value: new THREE.Color() },
            mode: { value: 0 },
            farPlane: { value: 1 }
        },
        defaultAttributeValues: { terrainSourceOffset: [0] },
        vertexShader: `attribute float terrainSourceOffset;
        uniform float offset; varying float depth; varying float seed;
        void main(){vec4 p=vec4(position+vec3(0.,0.,terrainSourceOffset*offset),1.);
        seed=0.;
        #ifdef USE_INSTANCING
        p=instanceMatrix*p;seed=fract(sin(dot(instanceMatrix[3].xyz,vec3(.13,.27,.43)))*4375.);
        #endif
        vec4 eye=modelViewMatrix*p;depth=-eye.z;gl_Position=projectionMatrix*eye;}`,
        fragmentShader: `uniform vec3 color; uniform float mode,farPlane; varying float depth,seed;
        void main(){vec3 c=color;
        if(mode==1.)c=vec3(1.-clamp(log2(1.+max(0.,depth))/log2(1.+farPlane),0.,1.));
        if(mode==2.)c=vec3(.09,.045,.015);
        if(mode==3.)c=fract(color+vec3(seed,seed*.65,seed*.39));
        gl_FragColor=vec4(c,mode==4.?.56:1.);}`
    });
    // Trees use custom instanced attributes and buildings batch many footprints
    // in one draw. Keep their production vertex transform in the diagnostic pass.
    const variants = new Map();
    function vertexMaterial(o) {
        const original = o.material;
        const tree = !!o.geometry.attributes.crown && !!original.uniforms?.treeUp;
        const building = !!original.userData?.earthBuilding && !!o.geometry.attributes.seed;
        if (!tree && !building) return shader;
        let m = variants.get(original);
        if (!m) {
            const body = original.vertexShader.replace(
                /void\s+main\s*\(/,
                "void positionGeometry("
            );
            m = new THREE.ShaderMaterial({
                defines: { ...original.defines },
                vertexColors: original.vertexColors,
                extensions: { ...original.extensions },
                side: original.side,
                uniforms: { ...original.uniforms, ...shader.uniforms },
                vertexShader:
                    body +
                    `\nvarying float debugSeed; varying float debugDepth;
                void main(){positionGeometry();debugDepth=gl_Position.w;debugSeed=` +
                    (tree
                        ? "fract(sin(dot(groundUv,vec2(47.3,91.7)))*4375.)"
                        : "fract(seed*173.79)") +
                    ";}",
                fragmentShader: shader.fragmentShader
                    .replace(/\bseed\b/g, "debugSeed")
                    .replace(/\bdepth\b/g, "debugDepth")
            });
            variants.set(original, m);
        }
        m.transparent = shader.transparent;
        m.depthTest = shader.depthTest;
        m.depthWrite = shader.depthWrite;
        m.blending = shader.blending;
        return m;
    }
    function draw(mode, tiles, pinned) {
        const terrain = new Set(tiles.flatMap(t => t.objects));
        shader.wireframe = mode === "Triangles";
        const overdraw = mode === "Overdraw";
        const sourceView = mode === "Terrain source";
        shader.transparent = overdraw || sourceView;
        shader.depthTest = shader.depthWrite = !overdraw;
        shader.blending = overdraw ? THREE.AdditiveBlending : sourceView ? THREE.NormalBlending : THREE.NoBlending;
        shader.uniforms.mode.value =
            mode === "Depth" ? 1 : overdraw ? 2 : mode === "Instances" ? 3 : sourceView ? 4 : 0;
        shader.uniforms.farPlane.value = map.camera.far;
        const used = new Set();
        map.scene.traverseVisible(o => {
            if (
                !o.isMesh ||
                !o.geometry?.attributes.position ||
                !o.material ||
                (!Array.isArray(o.material) && !o.material.visible)
            )
                return;
            if (mode === "Terrain source" && !terrain.has(o) && !o.userData.lidarSurface) return;
            if ((mode === "Hierarchy" || mode === "Triangles") && !terrain.has(o)) return;
            let obj = proxies.get(o);
            if (!obj) {
                obj = o.isInstancedMesh
                    ? new THREE.InstancedMesh(o.geometry, shader, 0)
                    : new THREE.Mesh(o.geometry, shader);
                obj.matrixAutoUpdate = false;
                obj.frustumCulled = false;
                obj.onBeforeRender = (...args) => {
                    if (obj.material !== shader) o.onBeforeRender(...args);
                    const level = o.userData.tileKey?.level ?? 0;
                    shader.uniforms.color.value.setHSL(
                        (modeNow === "Hierarchy" ? level * 0.137 : o.id * 0.618) % 1,
                        0.7,
                        0.55
                    );
                    if (modeNow === "Hierarchy" && selected === o)
                        shader.uniforms.color.value.setHex(0xffffff);
                    shader.stencilWrite = modeNow === "Terrain source" && !!o.material.stencilWrite;
                    if (shader.stencilWrite) {
                        for (const key of ["stencilRef", "stencilFunc", "stencilFuncMask", "stencilWriteMask", "stencilZPass"])
                            shader[key] = o.material[key];
                    }
                    if (modeNow === "Terrain source")
                        shader.uniforms.color.value.set(providers[providerOf(o)][1]);
                    shader.uniforms.offset.value =
                        o.material?.uniforms?.terrainSourceScale?.value || 0;
                    obj.material.uniformsNeedUpdate = true;
                };
                obj.onAfterRender = (...args) => {
                    if (obj.material !== shader) o.onAfterRender(...args);
                };
                proxies.set(o, obj);
            }
            obj.material = vertexMaterial(o);
            if (obj.material !== shader) used.add(o.material);
            obj.renderOrder = mode === "Terrain source" ? o.renderOrder : 0;
            obj.geometry = o.geometry;
            if (o.isInstancedMesh) {
                obj.instanceMatrix = o.instanceMatrix;
                obj.count = o.count;
            }
            obj.matrix.copy(o.matrixWorld);
            obj.matrixWorldNeedsUpdate = true;
            scene.add(obj);
        });
        for (const [original, m] of variants)
            if (!used.has(original)) {
                m.dispose();
                variants.delete(original);
            }
        modeNow = mode;
        selected = pinned?.objects[0];
        render(sourceView);
    }
    function render(preserveColor = false) {
        camera.copy(map.camera);
        camera.position.setScalar(0);
        camera.updateMatrixWorld(true);
        const renderer = map.renderer,
            auto = renderer.autoClear,
            color = renderer.getClearColor(new THREE.Color()),
            alpha = renderer.getClearAlpha();
        try {
            renderer.autoClear = false;
            renderer.setClearColor(0x000000, 1);
            renderer.clear(!preserveColor, true, true);
            renderer.render(scene, camera);
        } finally {
            renderer.setClearColor(color, alpha);
            renderer.autoClear = auto;
            for (const obj of scene.children) obj.parent = null;
            scene.children.length = 0;
        }
    }
    const patchMaterial = new THREE.ShaderMaterial({
        uniforms: {
            bounds: { value: new THREE.Vector4() },
            offset: { value: 0 },
            normalMix: { value: 0 }
        },
        defaultAttributeValues: {
            terrainSourceOffset: [0],
            terrainSourceNormal: [0, 0, 0],
            normal: [0, 0, 1]
        },
        vertexShader: `attribute float terrainSourceOffset;attribute vec3 terrainSourceNormal;
            uniform float offset,normalMix;varying vec2 tileUv;varying vec3 slope;
            void main(){ tileUv=vec2(uv.x,1.-uv.y);slope=normalMatrix*(normal+normalMix*terrainSourceNormal);
            vec3 p=position+vec3(0.,0.,offset*terrainSourceOffset);
            gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
        fragmentShader: `uniform vec4 bounds;varying vec2 tileUv;varying vec3 slope;
            void main(){if(any(lessThan(tileUv,bounds.xy))||any(greaterThan(tileUv,bounds.zw)))discard;
            float light=.4+.6*max(0.,dot(normalize(slope),normalize(vec3(-.5,.7,.5))));
            gl_FragColor=vec4(vec3(.69,.82,.79)*light,1.);}`
    });
    function overlaps(tile, cell) {
        const k = tile.tileKey,
            z = Math.min(k.level, cell.z);
        return (
            k.column >> (k.level - z) === cell.x >> (cell.z - z) &&
            k.row >> (k.level - z) === cell.y >> (cell.z - z)
        );
    }
    // Partition the pin's area by the finest available source. Every fragment
    // belongs to one mesh, even when a resident child covers just one quadrant.
    function patch(key, candidates, native) {
        function visit(cell, items) {
            const tile = items[0];
            if (!tile) return;
            const k = tile.tileKey;
            if (k.level > cell.z) {
                for (let i = 0; i < 4; i++) {
                    const sub = {
                        z: cell.z + 1,
                        x: cell.x * 2 + (i & 1),
                        y: cell.y * 2 + (i >> 1)
                    };
                    visit(
                        sub,
                        items.filter(t => overlaps(t, sub))
                    );
                }
                return;
            }
            const mesh = tile.objects[0],
                obj = new THREE.Mesh(mesh.geometry, patchMaterial);
            obj.frustumCulled = false;
            obj.matrixAutoUpdate = false;
            obj.matrix
                .copy(tile.boundingBox.getRotationMatrix())
                .setPosition(tile.center.clone().sub(map.camera.position));
            obj.matrixWorldNeedsUpdate = true;
            const size = 2 ** (k.level - cell.z),
                x = cell.x * size - k.column,
                y = cell.y * size - k.row;
            obj.onBeforeRender = () => {
                patchMaterial.uniforms.bounds.value.set(x, y, x + size, y + size);
                patchMaterial.uniforms.offset.value = native
                    ? 0
                    : mesh.material.uniforms?.terrainSourceScale?.value || 0;
                patchMaterial.uniforms.normalMix.value = native
                    ? 0
                    : mesh.material.uniforms?.terrainNormalMix?.value || 0;
                patchMaterial.uniformsNeedUpdate = true;
            };
            scene.add(obj);
        }
        if (key)
            visit(
                key,
                candidates.filter(t => overlaps(t, key))
            );
        render();
    }
    let modeNow, selected;
    return {
        draw,
        patch,
        dispose() {
            shader.dispose();
            patchMaterial.dispose();
            for (const m of variants.values()) m.dispose();
            variants.clear();
            selected = undefined;
        }
    };
}
module.exports = { diagnosticRender };
