/* Progressive globe imagery and horizon-safe camera. Apache-2.0.
 * Ancestor fallback / raster fades: MapLibre raster tile refinement model.
 * Horizon range and logarithmic depth: Cesium planetary rendering approach.
 */

const { R, transform } = require("./math");
const FADE_MS = 650,
    CACHE_LIMIT = 160,
    MAX_REQUESTS = 8;
function createImagery(THREE, map, ds, token, sky, environment) {
    const lifetime = require("./lifetime").createLifetime();
    const liveMaterials = new Set();
    ds.maxDataLevel = 14;
    const loader = require("./textures").createTextureLoader(THREE);
    const cache = new Map(),
        queue = new Map(),
        pending = new Set(),
        failures = new Map(),
        states = new WeakMap();
    let previous = new Map(),
        activeStates = [],
        pinned = new Set(),
        frame = 0,
        mode = "a",
        contoursEnabled = true,
        hillshadeStrength = 0.6,
        lastPrune = 0;
    const stats = {
        requests: 0,
        failures: 0,
        fading: 0,
        fallback: 0,
        cache: 0,
        pending: 0,
        untextured: 0
    };
    const neutral = new THREE.DataTexture(
        new Uint8Array([24, 42, 54, 255]),
        1,
        1,
        THREE.RGBAFormat
    );
    neutral.needsUpdate = true;
    const base = { texture: neutral, z: -1, x: 0, y: 0, key: "earth", last: 0 };
    loader.load(
        "/img/worldColour.5400x2700.jpg",
        texture => {
            if (lifetime.disposed) {
                texture.dispose();
                return;
            }
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.generateMipmaps = true;
            texture.anisotropy = Math.min(8, map.renderer.capabilities.getMaxAnisotropy());
            base.texture = texture;
            map.update();
        },
        undefined,
        () => {}
    );
    const key = (z, x, y) => `${z}/${x}/${y}`;
    const makeRef = (entry, tile) => ({
        entry,
        uv: entry.z < 0 ? [1, 1, 0, 0] : transform(tile, entry)
    });
    function request(z, x, y) {
        const k = (mode === "c" ? "c:" : "") + key(z, x, y);
        if (queue.has(k)) {
            queue.get(k).frame = frame;
            return;
        }
        if (cache.has(k) || pending.has(k)) return;
        if ((failures.get(k)?.retry || 0) > performance.now()) return;
        queue.set(k, { z, x, y, key: k, frame });
    }
    function pump() {
        const ordered = [...queue.values()]
            .filter(v => v.z === 0 || frame - v.frame < 3)
            .sort((a, b) => a.z - b.z);
        for (const entry of ordered) {
            if (pending.size >= MAX_REQUESTS) break;
            queue.delete(entry.key);
            pending.add(entry.key);
            stats.requests++;
            loader.load(
                entry.key.startsWith("c:")
                    ? `https://tile.openstreetmap.org/${entry.z}/${entry.x}/${entry.y}.png`
                    : `https://api.mapbox.com/v4/mapbox.satellite/${entry.z}/${entry.x}/${entry.y}@2x.png?access_token=${token}`,
                texture => {
                    if (lifetime.disposed) {
                        texture.dispose();
                        return;
                    }
                    texture.minFilter = THREE.LinearMipmapLinearFilter;
                    texture.magFilter = THREE.LinearFilter;
                    texture.generateMipmaps = true;
                    texture.anisotropy = Math.min(8, map.renderer.capabilities.getMaxAnisotropy());
                    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
                    entry.texture = texture;
                    entry.last = performance.now();
                    cache.set(entry.key, entry);
                    pending.delete(entry.key);
                    failures.delete(entry.key);
                    map.update();
                    pump();
                },
                undefined,
                () => {
                    if (lifetime.disposed) return;
                    pending.delete(entry.key);
                    stats.failures++;
                    const count = (failures.get(entry.key)?.count || 0) + 1;
                    failures.set(entry.key, {
                        count,
                        retry: performance.now() + Math.min(60000, 1000 * 2 ** count)
                    });
                    lifetime.timeout(() => map.update(), Math.min(60000, 1000 * 2 ** count) + 50);
                    map.update();
                    pump();
                }
            );
        }
    }
    function best(tile, excludeExact = false, maxLevel = tile.z) {
        for (let z = Math.min(maxLevel, tile.z - (excludeExact ? 1 : 0)); z >= 0; z--) {
            const div = 2 ** (tile.z - z),
                entry = cache.get(
                    (mode === "c" ? "c:" : "") +
                        key(z, Math.floor(tile.x / div), Math.floor(tile.y / div))
                );
            if (entry) {
                entry.last = performance.now();
                return makeRef(entry, tile);
            }
        }
        return makeRef(base, tile);
    }
    const { vertex, fragment } = require("./terrain-shaders");
    function material() {
        const result = new THREE.ShaderMaterial({
            vertexShader: vertex,
            fragmentShader: fragment,
            defines: { ATMOSPHERE_STEPS: 12 },
            extensions: { fragDepth: true, derivatives: true },
            uniforms: {
                ...sky.uniforms,
                ...environment.uniforms,
                parentMap: { value: neutral },
                parentUv: { value: new THREE.Vector4(1, 1, 0, 0) },
                parentBase: { value: 1 },
                edgeMask: { value: new THREE.Vector4() },
                fromMap: { value: neutral },
                toMap: { value: neutral },
                earthMap: { value: base.texture },
                fromUv: { value: new THREE.Vector4(1, 1, 0, 0) },
                toUv: { value: new THREE.Vector4(1, 1, 0, 0) },
                fromBase: { value: 1 },
                toBase: { value: 1 },
                blend: { value: 1 },
                overlayMode: { value: mode === "c" ? 1 : 0 },
                contoursEnabled: { value: contoursEnabled ? 1 : 0 },
                hillshadeStrength: { value: hillshadeStrength }
            }
        });
        result.userData.earthTerrain = true;
        liveMaterials.add(result);
        result.addEventListener("dispose", () => liveMaterials.delete(result));
        return result;
    }
    function drawRef(ctx, ref, tile, alpha = 1) {
        const image = ref.entry.texture.image;
        if (!image || !image.width || image.data) return false;
        ctx.globalAlpha = alpha;
        if (ref.entry.z < 0) {
            const n = 2 ** tile.z;
            for (let row = 0; row < 512; row++) {
                const lat = Math.atan(
                    Math.sinh(Math.PI * (1 - (2 * (tile.y + (row + 0.5) / 512)) / n))
                );
                ctx.drawImage(
                    image,
                    (tile.x / n) * image.width,
                    (0.5 - lat / Math.PI) * image.height,
                    image.width / n,
                    Math.max(1, image.height / n / 512),
                    0,
                    row,
                    512,
                    1
                );
            }
            return true;
        }
        const uv = ref.uv;
        ctx.drawImage(
            image,
            uv[2] * image.width,
            (1 - uv[3] - uv[1]) * image.height,
            uv[0] * image.width,
            uv[1] * image.height,
            0,
            0,
            512,
            512
        );
        return true;
    }
    function snapshot(state) {
        if (state.mix >= 1) return state.to;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 512;
        const ctx = canvas.getContext("2d");
        if (!drawRef(ctx, state.from, state.tile)) return state.to;
        drawRef(ctx, state.to, state.tile, state.mix);
        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        return {
            entry: { ...state.tile, texture, key: "snapshot", owned: true },
            uv: [1, 1, 0, 0]
        };
    }
    function oldView(tile, fallback) {
        const children = [...previous.values()].filter(
            s =>
                s.tile.z > tile.z &&
                s.tile.z <= tile.z + 3 &&
                Math.floor(s.tile.x / 2 ** (s.tile.z - tile.z)) === tile.x &&
                Math.floor(s.tile.y / 2 ** (s.tile.z - tile.z)) === tile.y
        );
        if (!children.length) return fallback;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 512;
        const ctx = canvas.getContext("2d");
        if (!drawRef(ctx, fallback, tile)) return fallback;
        for (const child of children) {
            const scale = 2 ** (child.tile.z - tile.z),
                x = ((child.tile.x - tile.x * scale) / scale) * 512,
                y = ((child.tile.y - tile.y * scale) / scale) * 512;
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(1 / scale, 1 / scale);
            drawRef(ctx, child.from, child.tile);
            drawRef(ctx, child.to, child.tile, child.mix);
            ctx.restore();
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        return {
            entry: { ...tile, texture, key: "mosaic", owned: true },
            uv: [1, 1, 0, 0]
        };
    }
    function bind(state, now) {
        const u = state.material.uniforms;
        const progress = Math.min(1, (now - state.start) / FADE_MS);
        state.mix = progress * progress * (3 - 2 * progress);
        const f = state.mix;
        u.fromMap.value = state.from.entry.texture;
        u.toMap.value = state.to.entry.texture;
        u.earthMap.value = base.texture;
        u.fromUv.value.fromArray(state.from.uv);
        u.toUv.value.fromArray(state.to.uv);
        u.fromBase.value = state.from.entry.z < 0 ? 1 : 0;
        u.toBase.value = state.to.entry.z < 0 ? 1 : 0;
        u.blend.value = f;
        if (state.mix >= 1 && state.from.entry.owned) {
            state.from.entry.texture.dispose();
            state.from = state.to;
            u.fromMap.value = state.to.entry.texture;
            u.fromUv.value.fromArray(state.to.uv);
            u.fromBase.value = u.toBase.value;
        }
        pinned.add(state.from.entry.key);
        pinned.add(state.to.entry.key);
    }
    const globe = new THREE.Mesh(new THREE.SphereGeometry(R - 25000, 256, 128), material());
    globe.renderOrder = -100;
    globe.frustumCulled = false;
    globe.anchor = new THREE.Vector3(0, 0, 0);
    map.mapAnchors.add(globe);
    function update(entries) {
        if (lifetime.disposed) return;
        frame++;
        const now = performance.now();
        globe.material.uniforms.earthMap.value = base.texture;
        const entry = entries.find(e => e.dataSource === ds);
        if (!entry) return;
        const current = new Map();
        activeStates = [];
        pinned = new Set(["0/0/0"]);
        stats.fading = stats.fallback = stats.untextured = 0;
        for (const tile of entry.renderedTiles.values()) {
            const tk = {
                    z: tile.tileKey.level,
                    x: tile.tileKey.column,
                    y: tile.tileKey.row
                },
                k = key(tk.z, tk.x, tk.y);
            for (let z = 0; z <= tk.z; z++) {
                const div = 2 ** (tk.z - z);
                request(z, Math.floor(tk.x / div), Math.floor(tk.y / div));
            }
            const target = best(tk);
            const edgeMask = [0, 0, 0, 0];
            let coarseLevel = tk.z;
            for (const neighbour of entry.renderedTiles.values()) {
                const n = neighbour.tileKey;
                if (n.level >= tk.z) continue;
                const scale = 2 ** (tk.z - n.level),
                    x0 = n.column * scale,
                    x1 = (n.column + 1) * scale,
                    y0 = n.row * scale,
                    y1 = (n.row + 1) * scale;
                if (tk.y >= y0 && tk.y < y1) {
                    if (tk.x === x1) {
                        edgeMask[0] = 1;
                        coarseLevel = Math.min(coarseLevel, n.level);
                    }
                    if (tk.x + 1 === x0) {
                        edgeMask[1] = 1;
                        coarseLevel = Math.min(coarseLevel, n.level);
                    }
                }
                if (tk.x >= x0 && tk.x < x1) {
                    if (tk.y === y1) {
                        edgeMask[2] = 1;
                        coarseLevel = Math.min(coarseLevel, n.level);
                    }
                    if (tk.y + 1 === y0) {
                        edgeMask[3] = 1;
                        coarseLevel = Math.min(coarseLevel, n.level);
                    }
                }
            }
            const edgeParent = best(tk, true, coarseLevel);
            for (const mesh of tile.objects) {
                if (!mesh.isMesh || !mesh.material.userData.earthTerrain) continue;
                let state = states.get(mesh);
                if (!state) {
                    state = {
                        tile: tk,
                        material: mesh.material,
                        from: oldView(tk, best(tk, true)),
                        to: target,
                        start: now,
                        mix: 0
                    };
                    states.set(mesh, state);
                    mesh.geometry.addEventListener("dispose", () => {
                        if (state.from.entry.owned) state.from.entry.texture.dispose();
                    });
                } else if (!previous.has(k)) {
                    if (state.from.entry.owned) state.from.entry.texture.dispose();
                    state.from = oldView(tk, best(tk, true));
                    state.to = target;
                    state.start = now;
                } else if (state.to.entry !== target.entry) {
                    const from = snapshot(state);
                    if (state.from.entry.owned && state.from !== from)
                        state.from.entry.texture.dispose();
                    state.from = from;
                    state.to = target;
                    state.start = now;
                }
                mesh.visible = true;
                bind(state, now);
                const uniforms = state.material.uniforms;
                uniforms.parentMap.value = edgeParent.entry.texture;
                uniforms.parentUv.value.fromArray(edgeParent.uv);
                uniforms.parentBase.value = edgeParent.entry.z < 0 ? 1 : 0;
                uniforms.edgeMask.value.fromArray(edgeMask);
                pinned.add(edgeParent.entry.key);
                // Continuity skirts use the same shader and transition state as their parent.
                for (const child of mesh.children)
                    if (child.isMesh) child.material = state.material;
                activeStates.push(state);
                current.set(k, state);
                if (state.mix < 1) stats.fading++;
                if (target.entry.z < tk.z) stats.fallback++;
                if (target.entry.z < 0) stats.untextured++;
            }
        }
        previous = current;
        for (const [k, v] of queue) if (v.z !== 0 && frame - v.frame > 2) queue.delete(k);
        pump();
        stats.cache = cache.size;
        stats.pending = pending.size;
        if (cache.size > CACHE_LIMIT || now - lastPrune > 2000) {
            lastPrune = now;
            const unused = [...cache.values()]
                .filter(e => !pinned.has(e.key))
                .sort((a, b) => a.last - b.last);
            while (cache.size > CACHE_LIMIT && unused.length) {
                const e = unused.shift();
                cache.delete(e.key);
                e.texture.dispose();
            }
        }
        stats.cache = cache.size;
        if (stats.fading) map.update();
    }
    ds.createTileMaterial = () => material();
    return {
        createTileMaterial: () => material(),
        dispose() {
            if (lifetime.disposed) return;
            lifetime.dispose();
            loader.dispose();
            ds.createTileMaterial = () => undefined;
            map.mapAnchors.remove(globe);
            globe.geometry.dispose();
            for (const material of [...liveMaterials]) material.dispose();
            for (const entry of cache.values()) entry.texture.dispose();
            for (const state of activeStates)
                if (state.from.entry.owned) state.from.entry.texture.dispose();
            base.texture.dispose();
            neutral.dispose();
            cache.clear();
            queue.clear();
            pending.clear();
            failures.clear();
            previous.clear();
            activeStates = [];
        },
        update,
        stats,
        setContours(value) {
            contoursEnabled = value;
            for (const m of liveMaterials) m.uniforms.contoursEnabled.value = value ? 1 : 0;
            map.update();
        },
        setHillshade(value) {
            hillshadeStrength = value;
            for (const m of liveMaterials) m.uniforms.hillshadeStrength.value = value;
            map.update();
        },
        setMode: value => {
            mode = value;
            for (const material of liveMaterials)
                material.uniforms.overlayMode.value = value === "c" ? 1 : 0;
            map.update();
        },
        get cacheSize() {
            return cache.size;
        },
        get pendingCount() {
            return pending.size;
        }
    };
}

module.exports = { createImagery };
