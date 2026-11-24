/* Progressive globe imagery and horizon-safe camera. Apache-2.0.
 * Ancestor fallback / raster fades: MapLibre raster tile refinement model.
 * Horizon range and logarithmic depth: Cesium planetary rendering approach.
 */

const { R, transform } = require("./math");
const { drawRaster, estimatedBytes } = require("./textures");
const { createSurfaceLookup, neighbourTransform } = require("./imagery-surface");
const { createReadmission, coversPreviousSample } = require("./imagery-admission");
const { carriedPages } = require("./imagery-coverage");
const {
    firstAvailable,
    isUniformWater,
    createUniformPages,
    residentPage,
    sourceLevel
} = require("./imagery-provider");
const FADE_MS = 380,
    CACHE_LIMIT = 160,
    CACHE_BYTES = 96 * 1024 * 1024,
    MAX_REQUESTS = 8;
function createImagery(THREE, map, ds, token, sky, environment, options = {}) {
    let diagnostic, maskRequest, maskRetry=0, orbitActive=false;

    const waterModel = options.waterModel;
    const waterDefines = {};
    if (["shared", "waves", "clouds", "planar", "coastal"].includes(waterModel)) waterDefines.EARTH_WATER_MODEL = 1;
    if (["waves", "clouds", "planar", "coastal"].includes(waterModel)) waterDefines.EARTH_WATER_FILTER = 1;
    if (options.slopeGlint) waterDefines.EARTH_WATER_SLOPES=1;
    if (waterModel === "coastal") waterDefines.EARTH_WATER_BODY = 1;
    if (options.cloudProbe) waterDefines.EARTH_WATER_CLOUDS = 1;
    if (options.planarProbe) waterDefines.EARTH_WATER_PLANAR = 1;
    if (options.waterDebug) waterDefines.EARTH_WATER_DEBUG = 1;
    const openSource = require("./open-imagery").sources[options.openImagery];
    const openImagery = !!openSource;
    const maxRequests = openImagery ? 4 : MAX_REQUESTS;
    const lifetime = require("./lifetime").createLifetime();
    const cacheBytes = options.cacheBytes ?? CACHE_BYTES,
        cacheLimit = options.cacheLimit ?? CACHE_LIMIT;
    const readmission = createReadmission(cacheBytes, cacheLimit, FADE_MS);
    let admissionDeadline = Infinity;
    const liveMaterials = new Set();
    const loader = require("./textures").createTextureLoader(THREE);
    const compressedPages = options.compressedPages ? require("./compressed-pages").createCompressedPages(THREE, map, options.compressedPages) : undefined;
    let measuredPageBytes = 1398100;
    const openPageBytes = openSource && estimatedBytes({
        image: { width: openSource.tileSize, height: openSource.tileSize },
        generateMipmaps: true
    });
    function workingBudget() {
        // A stationary open-survey view can retain four 256px mip chains in
        // the space of one 512px page. Keep the smaller demand set during
        // navigation and on metered data-saving connections.
        const refineSurvey = openSource && !map.cameraIsMoving && !globalThis.navigator?.connection?.saveData;
        const bytesPerPage = refineSurvey ? openPageBytes : compressedPages ? measuredPageBytes : undefined;
        return pageBudgets(cacheBytes, cacheLimit, bytesPerPage, refineSurvey);
    }
    const cache = new Map(),
        queue = new Map(),
        pending = new Map(),
        failures = new Map(),
        missing = new Map(),
        states = new WeakMap();
    let previous = new Map(),
        activeStates = [],
        pinned = new Set(),
        mode = "a",
        contoursEnabled = true,
        hillshadeStrength = 0.6,
        lastPrune = 0;
    const formats = require("./imagery-provider").createFormatPolicy();
    const stats = {
        requests: 0,
        snapshots: 0,
        mosaics: 0,
        failures: 0,
        stalledRequests: 0,
        formatFallbacks: 0,
        providerStatus: "ready",
        fading: 0,
        fallback: 0,
        cache: 0,
        cacheBytes: 0,
        pending: 0,
        untextured: 0,
        canceled: 0,
        unavailable: 0,
        encodedBytes: 0,
        oceanSuppressed: 0,
        oceanTiles: 0,
        uniformPages: 0,
        mosaicPixels: 0,
        previewRequests: 0,
        compactRequests: 0,
        compressedPages: 0,
        previewZoom: 0,
        detailRequests: 0,
        detailBindings: 0,
        detailHighestZoom: 0,
        detailWanted: 0,
        feedbackMs: 0,
        feedbackRuns: 0,
        screenVelocity: 0,
        motionBias: 0,
        screenPixelsAtTarget: 0,
        meanMissingLevels: 0,
        idleSkips: 0,
        feedbackSamples: 0
    };
    const { createRefinement, pageBudgets } = require("./imagery-refinement");
    const refinement = createRefinement(
        THREE,
        map,
        options,
        lifetime,
        stats,
        workingBudget(),
        !!token || openImagery,
        compressedPages || openSource ? workingBudget : undefined
    );
    const surface = createSurfaceLookup();
    const uniformPages = createUniformPages();
    const preview = require("./imagery-preview").createPreview(map);
    let previousBias = 0,
        previousRoadActive = false,previousWaterRevision=-1,
        previousWarm,
        previousMoving,
        staleTimer,
        staleDeadline = Infinity;
    lifetime.own(() => clearTimeout(staleTimer));
    let topology = 0,
        revision = 0,
        lastRevision = -1;
    const backoff = require("./imagery-backoff").createBackoff(() => {
        revision++;
        map.update();
    });
    lifetime.own(backoff.dispose);
    const updateOcean =
        waterModel !== "coastal" && sky.uniforms.skyViewAtlas && token
            ? require("./ocean-surface").createOcean(THREE, map, lifetime, () => {
                  revision++;
                  map.update();
              })
            : undefined;
    if (globalThis.addEventListener)
        lifetime.listen(globalThis, "online", () => {
            failures.clear();
            globalSurface.retry();
            revision++;
            map.update();
        });
    const neutral = new THREE.DataTexture(
        new Uint8Array([24, 42, 54, 255]),
        1,
        1,
        THREE.RGBAFormat
    );
    neutral.needsUpdate = true;
    const globalSurface = require("./global-surface").createGlobalSurface(
        THREE,
        loader,
        map,
        token,
        options,
        () => {
            revision++;
            map.update();
        }
    );
    const { base } = globalSurface;
    const oceanRelief =
        !options.orbital && sky.uniforms.oceanReliefWeight
            ? require("./ocean-relief").createRelief(THREE, loader, map, () => {
                  revision++;
                  map.update();
              })
            : undefined;
    const overview = () => oceanRelief?.texture || base.texture;
    const key = (z, x, y) => `${z}/${x}/${y}`;
    const makeRef = (entry, tile) => ({
        entry,
        uv: entry.z < 0 ? [1, 1, 0, 0] : transform(tile, entry)
    });
    function request(z, x, y, score, detail, now, preview = false, provisional = false) {
        if (diagnostic?.holdImagery || (diagnostic?.prefetchOff && preview)) return;
        if (mode === "a" && !token && !openImagery) return;
        if (mode === "a" && openImagery) {
            if (z < openSource.minZoom) return;
            if (z > openSource.maxZoom) {
                const scale = 2 ** (z - openSource.maxZoom);
                x = Math.floor(x / scale);
                y = Math.floor(y / scale);
                z = openSource.maxZoom;
            }
            if (!openSource.tile(z, x, y)) return;
            provisional = false;
        }
        // A half-density child has the same ground texel size as its 512px
        // parent. Share the native parent among moving siblings and reuse
        // its URL on return. Only the one landing preview needs its own tile.
        if (provisional && !preview && mode === "a" && z > 0) {
            z--;
            x = Math.floor(x / 2);
            y = Math.floor(y / 2);
            provisional = false;
        }
        const address = (mode !== "a" ? "c:" : "") + key(z, x, y);
        const smallKey = "s:" + address;
        // Full-sized work already underway or resident satisfies a temporary
        // request. If the provider lacks a small variant, try its native page.
        const compact = provisional && !openImagery && mode === "a" && (missing.get(smallKey)?.until || 0) <= now;
        const k = compact ? smallKey : address;
        if (compact) {
            if (cache.has(address) || queue.has(address)) return;
            const native = pending.get(address);
            if (native) {
                native.wanted = now;
                return;
            }
        } else queue.delete(smallKey);
        const active = pending.get(k);
        if (active) {
            active.wanted = now;
            return;
        }
        if (
            cache.has(k) ||
            (failures.get(k)?.retry || 0) > now ||
            (missing.get(k)?.until || 0) > now
        )
            return;
        if (!preview) {
            const until = readmission.blockedUntil(k, now, stats.feedbackRuns);
            if (until > now) {
                admissionDeadline = Math.min(admissionDeadline, until);
                return;
            }
        }
        const existing = queue.get(k);
        if (existing) {
            existing.score += score;
            existing.detail = existing.detail && detail;
        } else queue.set(k, { z, x, y, key: k, score, detail, preview, compact, wanted: now });
    }
    function pump() {
        if (
            diagnostic?.holdImagery || !queue.size ||
            pending.size >= maxRequests ||
            globalThis.navigator?.onLine === false ||
            !backoff.canStart(mode === "a" ? "" : "c:")
        )
            return;
        const ordered = [...queue.values()].sort((a, b) => b.score - a.score || a.z - b.z);
        const baseWork = ordered.some(e => !e.detail);
        const detailLimit = map.cameraIsMoving ? 1 : baseWork ? 3 : maxRequests;
        let detailInFlight = [...pending.values()].filter(e => e.detail).length;
        // Give fine foreground pages two slots while loading broad coverage.
        const reserved = ordered
            .filter(e => e.detail)
            .slice(0, Math.max(0, Math.min(2, detailLimit) - detailInFlight));
        for (const entry of [...reserved, ...ordered]) {
            if (pending.size >= maxRequests) break;
            if (
                !queue.has(entry.key) ||
                !backoff.canStart(entry.key) ||
                (entry.detail && detailInFlight >= detailLimit)
            )
                continue;
            queue.delete(entry.key);
            backoff.started(entry);
            pending.set(entry.key, entry);
            if (entry.detail) {
                detailInFlight++;
                stats.detailRequests++;
            }
            stats.requests++;
            if (entry.compact) stats.compactRequests++;
            if (entry.preview) stats.previewRequests++;
            const format = formats.format(entry.key, performance.now());
            entry.cancel = loader.load(
                entry.key.startsWith("c:")
                    ? `https://tile.openstreetmap.org/${entry.z}/${entry.x}/${entry.y}.png`
                    : openImagery ? openSource.tile(entry.z, entry.x, entry.y)
                    : `https://api.mapbox.com/v4/mapbox.satellite/${entry.z}/${entry.x}/${entry.y}${entry.compact ? "" : "@2x"}.${format}?access_token=${token}`,
                texture => {
                    if (lifetime.disposed || pending.get(entry.key) !== entry) {
                        texture.dispose();
                        return;
                    }
                    backoff.success(entry);
                    texture.minFilter = THREE.LinearMipmapLinearFilter;
                    texture.magFilter = THREE.LinearFilter;
                    texture.generateMipmaps = !texture.isCompressedTexture;
                    texture.anisotropy = Math.min(8, map.renderer.capabilities.getMaxAnisotropy());
                    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
                    if (!entry.key.startsWith("c:")) {
                        const pixel = uniformPages.compact(texture);
                        if (pixel) {
                            stats.uniformPages++;
                            if (!entry.compact && isUniformWater(pixel))
                                entry.flatWater = pixel.slice(0, 3).map(c => (c / 255) ** 2.2);
                            texture.minFilter = THREE.LinearFilter;
                        }
                    }
                    entry.texture = texture;
                    entry.last = entry.readyAt = performance.now();
                    entry.bytes = estimatedBytes(texture);
                    if(compressedPages && !entry.compact && !entry.key.startsWith("c:") && texture.image?.width===512){
                        measuredPageBytes=.88*measuredPageBytes+.12*entry.bytes;
                        if(texture.isCompressedTexture)stats.compressedPages++;
                    }
                    delete entry.cancel;
                    stats.cacheBytes += entry.bytes;
                    stats.encodedBytes += texture.userData.encodedBytes || 0;
                    cache.set(entry.key, entry);
                    revision++;
                    pending.delete(entry.key);
                    failures.delete(entry.key);
                    map.update();
                    pump();
                },
                undefined,
                error => {
                    if (lifetime.disposed || pending.get(entry.key) !== entry) return;
                    pending.delete(entry.key);
                    revision++;
                    const status = error?.status;
                    if (error?.stalled) stats.stalledRequests++;
                    if (!openImagery && formats.rejected(entry.key, format, error, performance.now())) {
                        backoff.cancel(entry);
                        stats.formatFallbacks++;
                        queue.set(entry.key, entry);
                        map.update();
                        pump();
                        return;
                    }
                    // The official Swiss WMTS uses 400 for a tile outside
                    // its published product grid, rather than 404.
                    if (status === 404 || status === 410 || (options.openImagery === "swissimage" && status === 400)) {
                        backoff.success(entry);
                        if (missing.size >= 512) missing.delete(missing.keys().next().value);
                        missing.set(entry.key, { until: performance.now() + 900000 });
                        stats.unavailable++;
                        map.update();
                        pump();
                        return;
                    }
                    stats.failures++;
                    if (format === "jpg80" && /decod/i.test(error?.message || ""))
                        error.codecExhausted = true;
                    if (backoff.failed(entry, error)) {
                        map.update();
                        pump();
                        return;
                    }
                    // Release a recovery probe for an isolated invalid page.
                    backoff.cancel(entry);
                    const count = (failures.get(entry.key)?.count || 0) + 1;
                    const delay = Math.min(60000, 1000 * 2 ** count);
                    if (!failures.has(entry.key) && failures.size >= 512)
                        failures.delete(failures.keys().next().value);
                    failures.set(entry.key, { count, retry: performance.now() + delay });
                    lifetime.timeout(() => {
                        revision++;
                        map.update();
                    }, delay + 50);
                    map.update();
                    pump();
                },
                { bitmap: true, compress: entry.key.startsWith("c:") || openImagery ? undefined : compressedPages }
            );
        }
    }
    function best(tile, excludeExact = false, maxLevel = tile.z, allowed) {
        for (let z = Math.min(maxLevel, tile.z - (excludeExact ? 1 : 0)); z >= 0; z--) {
            const div = 2 ** (tile.z - z),
                entry = residentPage(
                    cache,
                    (mode !== "a" ? "c:" : "") +
                        key(z, Math.floor(tile.x / div), Math.floor(tile.y / div))
                );
            if (entry && (!allowed || allowed.has(entry.key))) {
                entry.last = performance.now();
                return makeRef(entry, tile);
            }
        }
        return makeRef(base, tile);
    }
    const { vertex, fragment } = require("./terrain-shaders");
    const bounds = require("./terrain-reference");
    const radians = Math.PI / 180;
    const mercatorY = degrees => Math.asinh(Math.tan(degrees * radians));
    const referenceBounds = new THREE.Vector4(
        bounds.west * radians,
        mercatorY(bounds.south),
        (bounds.east - bounds.west) * radians,
        mercatorY(bounds.north) - mercatorY(bounds.south)
    );
    const referenceMap = { value: neutral };
    let loadingReference = false;
    function updateReference(material) {
        const cartographic = mode !== "a" && !material.defines.EARTH_ORBITAL;
        const enabled = cartographic && mode === "reference" && referenceMap.value !== neutral;
        if (
            !!material.defines.EARTH_REFERENCE === enabled &&
            !!material.defines.EARTH_CARTOGRAPHIC === cartographic
        )
            return;
        if (cartographic) material.defines.EARTH_CARTOGRAPHIC = 1;
        else delete material.defines.EARTH_CARTOGRAPHIC;
        if (enabled) material.defines.EARTH_REFERENCE = 1;
        else delete material.defines.EARTH_REFERENCE;
        material.needsUpdate = true;
    }
    function material(orbital = false) {
        const result = new THREE.ShaderMaterial({
            vertexShader: vertex,
            fragmentShader: fragment,
            defines: {
                ...(!orbital && waterDefines),
                ATMOSPHERE_STEPS: 12,
                ...(openImagery && !orbital ? { EARTH_OPEN_IMAGERY: 1 } : {}),
                ...(sky.aerial && !orbital ? { EARTH_AERIAL_ATLAS: 1 } : {}),
                ...(environment.localLights && !orbital ? { EARTH_LOCAL_LIGHTS: 1 } : {}),
                EARTH_DETAIL_SLOTS: orbital ? 0 : refinement.slots,
                ...(refinement.shareOverview && !orbital ? { EARTH_SHARED_OVERVIEW: 1 } : {}),
                ...(orbital ? { EARTH_ORBITAL: 1 } : {}),
                ...(orbital && sky.cache ? { EARTH_ATMOSPHERE_CACHE: 1 } : {})
            },
            extensions: { fragDepth: true, derivatives: true, shaderTextureLOD: true },
            uniforms: {
                ...sky.uniforms,
                ...environment.uniforms,
                ...(!orbital ? refinement.uniforms(neutral) : {}),
                terrainSourceScale: { value: 0 },
                terrainNormalMix: { value: 0 },
                roadAtlas: { value: neutral },
                roadUv: { value: new THREE.Vector4() },
                ...options.cloudProbe?.uniforms, ...options.planarProbe?.uniforms,
                waterWind: {value: options.windScale ?? 0.45},
                mappedWater:{value:neutral},waterFades:{value:new Float32Array(16)},waveDetail:{value:0},waterUv:{value:new THREE.Vector4()},waterPhase:{value:new THREE.Vector2()},
                referenceMap,
                referenceBounds: { value: referenceBounds },
                parentMap: { value: neutral },
                parentUv: { value: new THREE.Vector4(1, 1, 0, 0) },
                parentBase: { value: 1 },
                edgeMask: { value: new THREE.Vector4() },
                fromMap: { value: neutral },
                toMap: { value: neutral },
                earthMap: { value: overview() },
                fromUv: { value: new THREE.Vector4(1, 1, 0, 0) },
                toUv: { value: new THREE.Vector4(1, 1, 0, 0) },
                fromBase: { value: 1 },
                toBase: { value: 1 },
                blend: { value: 1 },
                overlayMode: { value: mode !== "a" ? 1 : 0 },
                contoursEnabled: { value: contoursEnabled ? 1 : 0 },
                hillshadeStrength: { value: hillshadeStrength }
            }
        });
        result.userData.earthTerrain = true;
        updateReference(result);
        liveMaterials.add(result);
        result.addEventListener("dispose", () => liveMaterials.delete(result));
        result.defaultAttributeValues.terrainSourceOffset = [0];
        result.defaultAttributeValues.terrainSourceNormal = [0, 0, 0];
        return result;
    }
    function drawRef(ctx, ref, tile, alpha = 1) {
        const image = ref.entry.texture.image;
        if (!image || !image.width || image.data) return false;
        ctx.globalAlpha = alpha;
        if (image.width === 1 && image.height === 1) {
            ctx.drawImage(image, 0, 0, 512, 512);
            return true;
        }
        if (ref.entry.z < 0) {
            const n = 2 ** tile.z;
            const bands = tile.z < 3 ? 32 : 4;
            const imageY = row =>
                (0.5 -
                    Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + row / bands)) / n))) /
                        Math.PI) *
                image.height;
            for (let row = 0; row < bands; row++) {
                const y0 = imageY(row),
                    y1 = imageY(row + 1);
                drawRaster(
                    ctx,
                    ref.entry.texture,
                    (tile.x / n) * image.width,
                    y0,
                    image.width / n,
                    y1 - y0,
                    0,
                    (row * 512) / bands,
                    512,
                    512 / bands
                );
            }
            return true;
        }
        const uv = ref.uv;
        drawRaster(
            ctx,
            ref.entry.texture,
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
    function contains(outer, inner) {
        if (outer.z > inner.z) return false;
        const scale = 2 ** (inner.z - outer.z);
        return Math.floor(inner.x / scale) === outer.x && Math.floor(inner.y / scale) === outer.y;
    }
    // A second DEM cut can occur before the first crossfade finishes. Its
    // children share the existing snapshot and its original fade clock.
    function retainFrom(entry, tile) {
        if (entry.owned) entry.references++;
        return makeRef(entry, tile);
    }
    function releaseFrom(state) {
        const entry = state.from.entry;
        if (!entry.owned) return;
        if (--entry.references === 0) entry.texture.dispose();
        state.from = state.to;
    }
    function handoff(state, target, fallback, samples, now, pages) {
        const tile = state.tile;
        let parent;
        for (let z = tile.z; z >= 0 && !parent; z--) {
            const scale = 2 ** (tile.z - z);
            parent = previous.get(key(z, Math.floor(tile.x / scale), Math.floor(tile.y / scale)));
        }
        state.to = target;
        state.start = state.detailTime = now;
        state.details = [];
        if (!parent) {
            state.from = oldView(state, fallback, samples, pages);
            return;
        }
        // A DEM refinement changes geometry under the same pixels. Reproject
        // the pages actually on screen, including their current fade amounts.
        // A copied patch has its own fade and never owns the shared cache image.
        if (parent.mix < 1) {
            state.from = retainFrom(parent.from.entry, tile);
            state.to = makeRef(parent.to.entry, tile);
            state.start = parent.start;
        } else {
            const baseRef = parent.mix >= 0.5 ? parent.to : parent.from;
            state.from = retainFrom(baseRef.entry, tile);
        }
        for (const { entry, alpha } of parent.details || []) {
            if (alpha <= 0 || cache.get(entry.key) !== entry) continue;
            if (contains(entry, tile) && alpha === 1) {
                releaseFrom(state);
                state.from = makeRef(entry, tile);
                state.to = target;
                state.start = now;
                state.details = [];
            } else if (contains(tile, entry) || contains(entry, tile)) {
                state.details.push({ entry, alpha, uv: transform(tile, entry) });
            }
        }
    }
    function oldView(state, fallback, samples, pages) {
        const tile = state.tile;
        const children = [...previous.values()].filter(
            s => s.tile.z > tile.z && contains(tile, s.tile)
        );
        // A coast seen from a low angle may occupy just a tiny corner of the
        // new coarse tile. A root-sized 512px mosaic cannot preserve those
        // fine pixels. Carry their actual textures in the same bounded slots.
        if (mode === "a" && refinement.slots && children.length) {
            const shared = new Map();
            const offer = (entry, alpha) => {
                if (entry.z <= tile.z || !alpha || cache.get(entry.key) !== entry) return;
                const old = shared.get(entry);
                if (!old || old.alpha < alpha)
                    shared.set(entry, { entry, alpha, uv: transform(tile, entry) });
            };
            for (const child of children) {
                if (child.from.entry === child.to.entry) offer(child.to.entry, 1);
                else {
                    offer(child.from.entry, 1 - child.mix);
                    offer(child.to.entry, child.mix);
                }
                for (const patch of child.details || []) offer(patch.entry, patch.alpha);
            }
            const priority = new Map((pages || []).map(page => [page.key, page.score]));
            const score = page => priority.get(page.entry.key) ??
                refinement.plan.selected.get(page.entry.key)?.score ?? page.alpha / 2 ** (page.entry.z - tile.z);
            state.details = carriedPages(
                [...shared.values()], tile, refinement.plan.samples, refinement.activeSlots, score
            );
        }
        // The GPU already has the fallback image. Children still displaying the
        // same ancestor contribute no pixels to a zoom-out mosaic.
        const changed = children.filter(
            child =>
                (child.mix < 1 && child.from.entry !== fallback.entry) ||
                (child.mix > 0 && child.to.entry !== fallback.entry) ||
                child.details?.some(page => page.alpha > 0)
        );
        if (!changed.length) return fallback;
        // A mosaic exists for just one fade. A distant ridge that covers
        // a few dozen pixels does not need a full-resolution canvas upload.
        const sampleArea =
            (map.canvas.width * map.canvas.height) / Math.max(1, refinement.plan.gridCells || 384);
        const area = Math.max(1, samples ?? 12) * sampleArea;
        const size = Math.max(64, Math.min(512, 2 ** Math.ceil(Math.log2(Math.sqrt(area)))));
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.scale(size / 512, size / 512);
        const fullChildren = changed.filter(
            child => child.tile.z === tile.z + 1 && child.mix === 1 && child.to.entry.z >= 0
        );
        if (fullChildren.length !== 4 && !drawRef(ctx, fallback, tile)) return fallback;
        for (const child of changed) {
            const scale = 2 ** (child.tile.z - tile.z),
                x = ((child.tile.x - tile.x * scale) / scale) * 512,
                y = ((child.tile.y - tile.y * scale) / scale) * 512;
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(1 / scale, 1 / scale);
            if (child.mix < 1) drawRef(ctx, child.from, child.tile);
            if (child.mix > 0) drawRef(ctx, child.to, child.tile, child.mix);
            for (const page of child.details || []) {
                if (page.alpha <= 0) continue;
                const entry = page.entry;
                const alpha = page.alpha * page.alpha * (3 - 2 * page.alpha);
                if (entry.z <= child.tile.z) {
                    drawRef(ctx, page, child.tile, alpha);
                } else {
                    const scale = 2 ** (entry.z - child.tile.z);
                    const size = 512 / scale;
                    const image = entry.texture.image;
                    ctx.globalAlpha = alpha;
                    drawRaster(ctx, entry.texture, 0, 0, image.width, image.height,
                        (entry.x - child.tile.x * scale) * size,
                        (entry.y - child.tile.y * scale) * size, size, size);
                }
            }
            ctx.restore();
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        stats.mosaics++;
        stats.mosaicPixels += size * size;
        return {
            entry: { ...tile, texture, key: "mosaic", owned: true, references: 1 },
            uv: [1, 1, 0, 0]
        };
    }
    function bind(state, now) {
        const u = state.material.uniforms;
        const progress =
            state.from.entry === state.to.entry ? 1 : Math.min(1, (now - state.start) / FADE_MS);
        state.mix = progress * progress * (3 - 2 * progress);
        const f = state.mix;
        u.fromMap.value = state.from.entry.z < 0 ? overview() : state.from.entry.texture;
        u.toMap.value = state.to.entry.z < 0 ? overview() : state.to.entry.texture;
        u.earthMap.value = overview();
        u.fromUv.value.fromArray(state.from.uv);
        u.toUv.value.fromArray(state.to.uv);
        u.fromBase.value = state.from.entry.z < 0 ? 1 : 0;
        u.toBase.value = state.to.entry.z < 0 ? 1 : 0;
        u.blend.value = f;
        if (state.mix >= 1 && state.from !== state.to) {
            releaseFrom(state);
            state.from = state.to;
            u.fromMap.value = u.toMap.value;
            u.fromUv.value.fromArray(state.to.uv);
            u.fromBase.value = u.toBase.value;
        }
        pinned.add(state.from.entry.key);
        pinned.add(state.to.entry.key);
    }
    // The interactive terrain fills uncovered rays in the sky pass. Only the
    // lightweight orbital renderer uses a dedicated sphere and haze cache.
    let globe;
    if (!sky.uniforms.fallbackSurface) {
        globe = new THREE.Mesh(new THREE.SphereGeometry(R, 256, 128), material(!!options.orbital));
        globe.renderOrder = -100;
        globe.frustumCulled = false;
        globe.anchor = new THREE.Vector3(0, 0, 0);
        map.mapAnchors.add(globe);
    }
    let seamMap = new Map();
    function updateSeams(rendered) {
        if (rendered.size === seamMap.size) {
            let changed = false;
            for (const tile of rendered.values()) {
                const previous = seamMap.get(tile);
                if (
                    !previous ||
                    previous.mesh !== tile.objects[0] ||
                    previous.count !== tile.objects.length
                ) {
                    changed = true;
                    break;
                }
            }
            if (!changed) return false;
        }
        topology++;
        const byKey = new Map();
        seamMap = new Map();
        for (const tile of rendered.values()) {
            const t = tile.tileKey;
            byKey.set(key(t.level, t.column, t.row), tile);
            seamMap.set(tile, {
                mesh: tile.objects[0],
                count: tile.objects.length,
                sides: [[], [], [], []]
            });
        }
        for (const tile of rendered.values()) {
            const tk = tile.tileKey,
                n = 2 ** tk.level;
            const adjacent = [
                [(tk.column + n - 1) % n, tk.row],
                [(tk.column + 1) % n, tk.row],
                [tk.column, tk.row - 1],
                [tk.column, tk.row + 1]
            ];
            adjacent.forEach(([x, y], side) => {
                if (y < 0 || y >= n) return;
                for (let z = tk.level; z >= 0; z--) {
                    const scale = 2 ** (tk.level - z);
                    const nx = Math.floor(x / scale),
                        ny = Math.floor(y / scale);
                    if (nx === Math.floor(tk.column / scale) && ny === Math.floor(tk.row / scale))
                        break;
                    const neighbour = byKey.get(key(z, nx, ny));
                    if (!neighbour) continue;
                    if (z < tk.level || side === 1 || side === 3) {
                        seamMap.get(tile).sides[side].push(neighbour);
                        seamMap.get(neighbour).sides[side ^ 1].push(tile);
                    }
                    break;
                }
            });
        }
        return true;
    }
    function update(entries) {
        if (lifetime.disposed) return;
        const now = performance.now();
        if (sky.uniforms.oceanReliefWeight) {
            const height = map.camera.position.length() * 0.001 - 6378.137;
            oceanRelief?.setRegional(height > 12 && mode === "a");
            const t = Math.max(0, Math.min(1, (height - 12) / 55));
            sky.uniforms.oceanReliefWeight.value =
                oceanRelief?.texture && mode === "a" ? t * t * (3 - 2 * t) : 0;
        }
        if (sky.uniforms.globalWaterMask) {
            const altitude = map.camera.position.length()*.001 - 6378.137;
            const mask = sky.uniforms.globalWaterMask;
            if (options.water?.stats.enabled && mode==="a" && altitude>8 && !mask.value && !maskRequest && now>=maskRetry) {
                maskRequest=loader.load("/earth-background/ocean-mask.webp",texture=>{
                    maskRequest=undefined;
                    if(lifetime.disposed){texture.dispose();return;}
                    texture.wrapS=THREE.RepeatWrapping;
                    mask.value=texture;
                    revision++;
                    map.update();
                },undefined,()=>{maskRequest=undefined;maskRetry=performance.now()+60000;});
            }
            const weight=Math.max(0,Math.min(1,(altitude-8)/22));
            sky.uniforms.globalWaterStrength.value=mode==="a" && options.water?.stats.enabled && mask.value ? weight*weight*(3-2*weight) : 0;
            const on=sky.uniforms.globalWaterStrength.value>0;
            if(orbitActive!==on){orbitActive=on;revision++;}
        }
        const provider = backoff.state(mode === "a" ? "" : "c:");
        stats.providerStatus = provider?.reason || "ready";
        globalSurface.update(map.zoomLevel, mode === "a" && provider?.reason === "authentication");
        if (globe) globe.material.uniforms.earthMap.value = overview();
        else {
            sky.uniforms.fallbackSurface.value = overview();
            sky.uniforms.fallbackLights.value = environment.uniforms.nightMap.value;
            sky.uniforms.fallbackLightStrength.value = environment.uniforms.lightsEnabled.value;
        }
        const entry = entries.find(e => e.dataSource === ds);
        if (!entry) return;
        const roadsActive = !!options.roads?.stats.active;
        const waterRevision=options.water?.revision||0;
        const extras=Number(orbitActive)+Number(roadsActive)+Number(!!options.water?.stats.active)*(1+Number(!!options.cloudProbe)+Number(!!options.planarProbe));
        const changed = updateSeams(entry.renderedTiles);
        const regional = !!sky.uniforms.oceanReliefWeight?.value;
        const replanned = refinement.update(entry.renderedTiles, mode, now, topology, extras, regional);
        if (replanned) ds.updateTerrainFeedback?.(refinement.plan.samples, now);
        // A rapid pan moves through a page before a full-resolution fetch
        // and fade can repay their cost. Bias only new requests; a page that
        // is already loaded stays sharp through the same camera movement.
        const speed = map.cameraIsMoving ? stats.screenVelocity : 0;
        const motionBias = speed > 1.4 ? 2 : speed > 0.35 ? 1 : 0;
        const warm = preview.update(mode, cache, missing, now, replanned, !!token || openImagery, motionBias >= 1);
        const fallbackPage = preview.get(now);
        stats.previewZoom = fallbackPage?.z || 0;
        if (fallbackPage && fallbackPage.fade < 1) map.update();
        // Clouds, time and building lights can drive additional frames after
        // streaming settles. Their uniforms are shared; tile bindings remain
        // valid until the camera, visibility, cache or a transition changes.
        if (
            !changed &&
            !replanned &&
            previousRoadActive === roadsActive && previousWaterRevision===waterRevision &&
            previousBias === motionBias &&
            lastRevision === revision &&
            !stats.fading &&
            previousWarm === warm?.key &&
            previousMoving === map.cameraIsMoving
        ) {
            stats.idleSkips++;
            return;
        }
        previousRoadActive = roadsActive;previousWaterRevision=waterRevision;
        previousWarm = warm?.key;
        previousMoving = map.cameraIsMoving;
        previousBias = stats.motionBias = motionBias;
        lastRevision = revision;
        surface.reset();
        const current = new Map();
        activeStates = [];
        pinned = new Set();
        admissionDeadline = Infinity;
        queue.clear();
        stats.fading = stats.fallback = stats.untextured = 0;
        stats.detailBindings = stats.detailHighestZoom = 0;
        const { plan } = refinement;
        const resident = refinement.residentPages(cache, revision);
        if (preview.activeKey) pinned.add(preview.activeKey);
        if (warm)
            request(
                warm.z,
                warm.x,
                warm.y,
                Math.max(60, stats.feedbackSamples * 0.6),
                false,
                now,
                true,
                true
            );
        const visible = new Map();
        let waterVisible = false;
        stats.oceanSuppressed = 0;
        const prefix = mode !== "a" ? "c:" : "";
        for (const tile of entry.renderedTiles.values()) {
            const tk = { z: tile.tileKey.level, x: tile.tileKey.column, y: tile.tileKey.row };
            const wanted = plan.base.get(tile) ?? Math.max(0, tk.z - 2);
            const available = firstAvailable(tk, wanted, 0, missing, now, prefix);
            let level = available?.z ?? -1;
            // A new geometry cut can arrive between visibility samples. Keep
            // nearby cached photos sharp until the next plan knows this tile.
            const drawLevel = plan.base.has(tile) ? level : tk.z;
            const target = best(tk, false, drawLevel);
            if (level >= 0) level = Math.max(0, level - motionBias);
            const coverage = plan.tiles.get(tile);
            let pages = coverage?.pages;
            let canDraw = true;
            const openOcean = mode === "a" && ds.isOpenOcean?.(tile.tileKey);
            if (openImagery && openOcean) {
                // A terrain-classified open-ocean mesh cannot contain source
                // land. Keep the overview and avoid empty WorldCover pages.
                level = -1;
                canDraw = false;
                pages = undefined;
            } else if (wanted >= 10 && openOcean) {
                const probeLevel = Math.min(12, level);
                if (
                    target.entry.z < probeLevel ||
                    (target.entry.compact && target.entry.z === probeLevel)
                ) {
                    level = probeLevel;
                    canDraw = false;
                    pages = undefined;
                } else if (target.entry.z >= 10 && target.entry.flatWater) {
                    level = target.entry.z;
                    stats.oceanSuppressed += pages?.length || 0;
                    canDraw = false;
                    pages = undefined;
                }
            }
            if (pages?.length) {
                // Missing children fall back to the nearest untested parent
                // above this mesh. Other branches retain their best imagery.
                for (const page of pages) {
                    const available = firstAvailable(page, page.z, tk.z + 1, missing, now);
                    if (available && (motionBias < 2 || pending.has(available.key)))
                        request(available.z, available.x, available.y, page.score, true, now);
                }
            }
            // Choose what to draw from *resident* pages. A missing ideal
            // page must not push out a useful cached intermediate on a pan.
            visible.set(tile, {
                tk,
                openOcean,
                level,
                target,
                pages: canDraw ? resident?.get(tile)?.pages : undefined
            });
        }
        for (const [tile, { tk, level, target, pages, openOcean }] of visible) {
            const k = key(tk.z, tk.x, tk.y),
                coverage = plan.tiles.get(tile);
            const weight = coverage?.samples || 0.125;
            const requestLevel = (z, provisional) => {
                const scale = 2 ** (tk.z - z);
                request(
                    z,
                    Math.floor(tk.x / scale),
                    Math.floor(tk.y / scale),
                    weight * Math.max(1, z - sourceLevel(target.entry)),
                    false,
                    now,
                    false,
                    provisional
                );
            };
            const provisional = motionBias > 0 && !openOcean;
            const needsBase = target.entry.z < level ||
                (target.entry.compact && target.entry.z === level && !provisional);
            if (needsBase && (mode !== "a" || openOcean || plan.base.has(tile) ||
                coversPreviousSample(tk, plan.samples))) {
                requestLevel(level, provisional);
                // One shared intermediate covers several siblings during
                // large jumps; going through every level wastes bandwidth.
                if (level - Math.max(0, target.entry.z) >= 5) requestLevel(level - 3, true);
            }
            for (const mesh of tile.objects) {
                if (!mesh.isMesh || !mesh.material.userData.earthTerrain) continue;
                let state = states.get(mesh);
                if (!state) {
                    const meta = mesh.geometry.userData.attributeMetadata?.position;
                    state = { tile: tk, material: mesh.material, mix: 0,
                        elevationLevel: meta?.terrainSourceLevel ?? tk.z,
                        elevationSegments: (meta?.terrainGridWidth ?? 1) - 1 };
                    handoff(state, target, best(tk, true, level), coverage?.samples, now, pages);
                    states.set(mesh, state);
                    mesh.geometry.addEventListener("dispose", () => {
                        releaseFrom(state);
                    });
                } else if (!previous.has(k)) {
                    releaseFrom(state);
                    handoff(state, target, best(tk, true, level), coverage?.samples, now, pages);
                } else if (state.to.entry !== target.entry && state.mix >= 1) {
                    // Finish the image already blending on the GPU; then
                    // jump directly to the best currently resident image.
                    state.from = state.to;
                    state.to = target;
                    state.start = now;
                }
                mesh.visible = true;
                bind(state, now);
                const info = visible.get(tile);
                info.state = state;
                info.water =
                    info.openOcean &&
                    state.to.entry.z >= 10 &&
                    (state.mix >= 1 || state.from.entry.flatWater) &&
                    state.to.entry.flatWater;
                if (info.water) waterVisible = true;
                pinned.add(target.entry.key);
                if (refinement.bind(state, pages, mode, cache, pinned, neutral, now, plan.base.has(tile)))
                    stats.fading++;
                options.roads?.bind(state.material,tile.tileKey,refinement.capacityFor(extras));
                options.water?.bind(state.material,tile.tileKey);
                if(!!state.material.defines.EARTH_WATER_ORBIT!==orbitActive){
                    if(orbitActive)state.material.defines.EARTH_WATER_ORBIT=1;
                    else delete state.material.defines.EARTH_WATER_ORBIT;
                    state.material.needsUpdate=true;
                }
                const slots=refinement.capacityFor(extras);
                if(state.material.defines.EARTH_DETAIL_SLOTS!==slots){
                    state.material.defines.EARTH_DETAIL_SLOTS=slots;state.material.needsUpdate=true;
                }
                if (state.to.entry !== target.entry) map.update();
                // Continuity skirts use the same shader and transition state as their parent.
                for (const child of mesh.children)
                    if (child.isMesh) child.material = state.material;
                activeStates.push(state);
                current.set(k, state);
                if (state.mix < 1) stats.fading++;
                if (sourceLevel(target.entry) < tk.z) stats.fallback++;
                if (target.entry.z < 0) stats.untextured++;
            }
        }
        updateOcean?.(visible, plan.samples || [], waterVisible, now, fragment, stats);
        // Match the source actually visible on the other side, independently
        // of geometry level. Clamping that neighbour's UVs carries its edge
        // colour into the higher resolution side with no extra pinned texture.
        for (const [tile, info] of visible) {
            const state = info.state;
            if (!state) continue;
            const level = sourceLevel(state.mix > 0.5 ? state.to.entry : state.from.entry);
            const mask = [0, 0, 0, 0];
            let lowest = level,
                source;
            seamMap.get(tile).sides.forEach((neighbours, side) => {
                for (const neighbour of neighbours) {
                    const ns = visible.get(neighbour)?.state;
                    if (!ns) continue;
                    const n = ns.mix > 0.5 ? ns.to.entry : ns.from.entry;
                    const neighborLevel = sourceLevel(n);
                    if (n.owned || neighborLevel >= level) continue;
                    if (neighborLevel < lowest) {
                        lowest = neighborLevel;
                        source = n;
                    }
                    mask[side] = Math.max(mask[side], level - neighborLevel);
                }
            });
            const u = state.material.uniforms;
            if (source) {
                // Prefer a matching ancestor on this tile's side if it is
                // already in the active working set. Otherwise extend the
                // neighbouring image across its shared border only.
                const matching = best(info.tk, false, lowest, pinned);
                const ancestor = sourceLevel(matching.entry) >= lowest ? matching.entry : undefined;
                if (!ancestor && source !== base) {
                    for (let side = 0; side < 4; side++) {
                        if (
                            !seamMap.get(tile).sides[side].some(n => {
                                const ns = visible.get(n)?.state;
                                return (
                                    ns && (ns.mix > 0.5 ? ns.to.entry : ns.from.entry) === source
                                );
                            })
                        )
                            mask[side] = 0;
                    }
                }
                const ref = makeRef(ancestor || source, info.tk);
                if (!ancestor && source !== base)
                    ref.uv = neighbourTransform(info.tk, source, mask);
                u.parentMap.value = ref.entry.z < 0 ? overview() : ref.entry.texture;
                u.parentUv.value.fromArray(ref.uv);
                u.parentBase.value = ref.entry.z < 0 ? 1 : 0;
                u.edgeMask.value.fromArray(mask);
            } else {
                u.parentMap.value = neutral;
                u.edgeMask.value.set(0, 0, 0, 0);
            }
        }
        let deficit = 0,
            satisfied = 0;
        for (const sample of plan.samples || []) {
            const state = visible.get(sample.tile)?.state;
            if (!state) continue;
            const from = state.from.entry,
                to = state.to.entry;
            if (state.mix < 0.99) from.drawn = true;
            if (state.mix > 0.01) to.drawn = true;
            let level = Math.max(
                0,
                (from.z < 0 ? 3 : sourceLevel(from)) * (1 - state.mix) +
                    (to.z < 0 ? 3 : sourceLevel(to)) * state.mix
            );
            for (const page of state.details || []) {
                const n = 2 ** page.entry.z;
                if (
                    Math.floor(sample.mx * n) === page.entry.x &&
                    Math.floor(sample.my * n) === page.entry.y
                ) {
                    if (page.alpha > 0.01) page.entry.drawn = true;
                    level = Math.max(level, level + (page.entry.z - level) * page.alpha);
                }
            }
            const d = Math.max(0, sample.z - level);
            deficit += d;
            if (d < 0.25) satisfied++;
        }
        const count = plan.samples?.length || 0;
        stats.screenPixelsAtTarget = count ? Math.round((100 * satisfied) / count) : 0;
        stats.meanMissingLevels = count ? deficit / count : 0;
        refinement.updateEdges(activeStates);
        for (const [k, state] of previous) {
            if (current.get(k) === state) continue;
            // Hidden harp geometry may live in its own cache. Release every
            // image reference here so evicting a page also frees decoded RAM.
            releaseFrom(state);
            state.from = state.to = makeRef(base, state.tile);
            state.details = [];
            if (state.material.userData.openSea) {
                state.material.userData.openSea = false;
                state.material.fragmentShader = fragment;
                state.material.needsUpdate = true;
            }
            const u = state.material.uniforms;
            u.parentMap.value = u.fromMap.value = u.toMap.value = neutral;
            u.earthMap.value = overview();
            for (let i = 0; i < refinement.slots; i++) {
                u["detailMap" + i].value = neutral;
                u["detailFade" + i].value = 0;
            }
        }
        previous = current;
        // Queued and in-flight work retains its ranking while the input view
        // is unchanged. Wake for abandoned jobs once their grace expires;
        // ongoing downloads do not require a full tile/material pass per frame.
        let deadline = admissionDeadline;
        for (const [k, job] of pending) {
            if (job.wanted === now || job.z < 4) {
                job.staleSince = undefined;
                continue;
            }
            job.staleSince ??= now;
            const expires = job.staleSince + (job.preview ? 60 : 350);
            if (expires > now) {
                deadline = Math.min(deadline, expires);
                continue;
            }
            backoff.cancel(job);
            job.cancel?.();
            pending.delete(k);
            stats.canceled++;
        }
        if (deadline !== staleDeadline) {
            clearTimeout(staleTimer);
            staleDeadline = deadline;
            if (Number.isFinite(deadline))
                staleTimer = setTimeout(
                    () => {
                        staleDeadline = Infinity;
                        revision++;
                        map.update();
                    },
                    Math.max(1, Math.ceil(deadline - now))
                );
        }
        pump();
        stats.cache = cache.size;
        stats.pending = pending.size;
        if (cache.size > cacheLimit || stats.cacheBytes > cacheBytes || now - lastPrune > 2000) {
            lastPrune = now;
            const unused = [...cache.values()]
                .filter(e => !pinned.has(e.key))
                .sort((a, b) => a.last - b.last);
            while ((cache.size > cacheLimit || stats.cacheBytes > cacheBytes) && unused.length) {
                const e = unused.shift();
                readmission.evicted(e, now, stats.feedbackRuns);
                cache.delete(e.key);
                stats.cacheBytes -= e.bytes;
                e.texture.dispose();
            }
        }
        stats.cache = cache.size;
        const moreSpace = readmission.updatePinned(cache, pinned);
        if (moreSpace) revision++;
        if (moreSpace || stats.fading) map.update();
    }
    ds.createTileMaterial = () => material();
    return {
        // Borrowed samples are valid for this draw. A consumer clears its
        // material's sampler uniforms after drawing so hidden building tiles
        // cannot keep an evicted decoded image alive.
        setOceanRelief(value) {
            oceanRelief?.set(value);
        },
        getPreviewPage() {
            return lifetime.disposed ? null : preview.get(performance.now());
        },
        setDiagnostic(value) {
            diagnostic = value;
            revision++;
            map.update();
        },
        debugPages() {
            const desired = [...refinement.plan.base].map(([tile, z]) => {
                const k = tile.tileKey;
                const shift = Math.max(0, k.level - z);
                return { z: k.level - shift, x: k.column >> shift, y: k.row >> shift };
            });
            return { desired: desired.concat([...refinement.plan.selected.values()]),
                queued: [...queue.values()], pending: [...pending.values()], resident: [...cache.values()] };
        },
        getTerrainState(tile){
            for(let z=tile.z;z>=0;z--){
                const n=2**(tile.z-z),state=previous.get(key(z,Math.floor(tile.x/n),Math.floor(tile.y/n)));
                if(state)return state;
            }
        },
        getSurfacePages(tileKey) {
            if (lifetime.disposed || mode !== "a") return surface.empty;
            return surface.get(tileKey, activeStates, refinement.plan.samples || [], cache);
        },
        get ready() {
            return globalSurface.ready;
        },
        createTileMaterial: () => material(),
        dispose() {
            if (lifetime.disposed) return;
            lifetime.dispose();
            compressedPages?.dispose();
            loader.dispose();
            ds.createTileMaterial = () => undefined;
            if (globe) {
                map.mapAnchors.remove(globe);
                globe.geometry.dispose();
            }
            for (const material of [...liveMaterials]) material.dispose();
            for (const entry of cache.values()) entry.texture.dispose();
            for (const state of activeStates) releaseFrom(state);
            maskRequest?.();
            sky.uniforms.globalWaterMask?.value?.dispose();
            oceanRelief?.dispose();
            globalSurface.dispose();
            if (referenceMap.value !== neutral) referenceMap.value.dispose();
            neutral.dispose();
            cache.clear();
            readmission.clear();
            stats.cacheBytes = 0;
            queue.clear();
            pending.clear();
            failures.clear();
            missing.clear();
            uniformPages.dispose();
            preview.dispose();
            surface.reset();
            refinement.dispose();
            seamMap.clear();
            pinned.clear();
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
            revision++;
            if (value === "reference" && referenceMap.value === neutral && !loadingReference) {
                loadingReference = true;
                loader.load(
                    "resources/earth/santa-barbara-google-terrain.png",
                    texture => {
                        texture.generateMipmaps = false;
                        texture.minFilter = THREE.LinearFilter;
                        referenceMap.value = texture;
                        loadingReference = false;
                        for (const material of liveMaterials) updateReference(material);
                        map.update();
                    },
                    undefined,
                    () => {
                        loadingReference = false;
                    }
                );
            }
            for (const material of liveMaterials) {
                material.uniforms.overlayMode.value = value !== "a" ? 1 : 0;
                updateReference(material);
            }
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
