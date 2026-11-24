import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { surveyTransform } from "./survey-region.js";
import { GLTFCesiumRTCExtension } from "3d-tiles-renderer/plugins";
import styles from "./survey-buildings.js";
import legacy from "./survey-legacy.js";
import lighting from "./survey-light.js";
import photoTextures from "./survey-textures.js";
import fallback from "./survey-fallback.js";
import geoid from "./survey-geoid.json";

function geoidHeight(lat, lon) {
    const grid = geoid.find(
        g =>
            lon >= g.west &&
            lon <= g.west + g.step * (g.nx - 1) &&
            lat >= g.south &&
            lat <= g.south + g.step * (g.samples.length / g.nx - 1)
    );
    if (!grid) return 0;
    const { west, south, step, nx, samples } = grid;
    const ix = Math.max(0, Math.min(nx - 1.00001, (lon - west) / step));
    const iy = Math.max(0, Math.min(samples.length / nx - 1.00001, (lat - south) / step));
    const x = Math.floor(ix),
        y = Math.floor(iy),
        u = ix - x,
        v = iy - y,
        i = x + y * nx;
    return (
        ((1 - u) * (1 - v) * samples[i] +
            u * (1 - v) * samples[i + 1] +
            (1 - u) * v * samples[i + nx] +
            u * v * samples[i + nx + 1]) *
        0.1
    );
}

// Directory-only levels have no geometry to replace. Visiting every sibling
// under a nationwide empty ancestor can consume the entire cache in JSON.
class SurveyRenderer extends TilesRenderer {
    constructor(url) {
        super(url);
        this.meanModelBytes = 512 * 1024;
        this.networkBytes = 0;
        for (const queue of [this.downloadQueue, this.parseQueue]) {
            const previous = queue.priorityCallback;
            queue.priorityCallback = (a, b) => {
                if (a.__used !== b.__used) return a.__used ? 1 : -1;
                if (a.__inFrustum !== b.__inFrustum) return a.__inFrustum ? 1 : -1;
                return (b.surveyFocusBand || 0) - (a.surveyFocusBand || 0) || previous(a, b);
            };
        }
        const oldest = this.lruCache.unloadPriorityCallback;
        this.lruCache.unloadPriorityCallback = (a, b) => {
            // Both admission and eviction use this comparator. Favour visible,
            // nearby geometry once its directory has been discovered.
            if (a.__inFrustum !== b.__inFrustum) return a.__inFrustum ? -1 : 1;
            const score = t =>
                (t.__hasUnrenderableContent ? -0.5 : 0) +
                Math.log2(1 + t.__distanceFromCamera / 160) +
                0.12 * t.__depthFromRenderedParent +
                (t.surveyFocusBand || 0);
            const delta = score(a) - score(b);
            return delta || oldest(a, b);
        };
    }
    async fetchData(url, options) {
        const signal = options.signal;
        const directory = /\.json(?:[?#]|$)/i.test(url);
        const guess = directory ? 32768 : this.meanModelBytes;
        // Wait inside the renderer's priority queue. Declining a traversal's
        // request can leave a replacement parent waiting for an unloaded child.
        while (true) {
            signal?.throwIfAborted();
            if (!(this.deferUntil > performance.now()) && this.budget.reserve(guess)) break;
            const delay = Math.max(
                50,
                this.deferUntil - performance.now() || 0,
                this.budget.delay(guess)
            );
            await new Promise((resolve, reject) => {
                const done = () => {
                    signal?.removeEventListener("abort", cancel);
                    resolve();
                };
                const timer = setTimeout(done, Math.min(1000, delay));
                function cancel() {
                    clearTimeout(timer);
                    reject(signal.reason);
                }
                signal?.addEventListener("abort", cancel, { once: true });
            });
        }
        try {
            const response = await fetch(url, options);
            if (!response.ok) return response;
            const buffer = await response.arrayBuffer();
            this.networkBytes += buffer.byteLength;
            this.budget.pay(buffer.byteLength);
            if (!directory)
                this.meanModelBytes = Math.max(
                    65536,
                    Math.min(3 * 1024 * 1024, 0.75 * this.meanModelBytes + 0.25 * buffer.byteLength)
                );
            return {
                ok: true,
                arrayBuffer: () => buffer,
                json: () => JSON.parse(new TextDecoder().decode(buffer))
            };
        } finally {
            this.budget.release(guess);
        }
    }
    preprocessNode(tile, dir, parent = null) {
        const refine = tile.refine || parent?.surveyRefine || "REPLACE";
        super.preprocessNode(tile, dir, parent);
        tile.surveyRefine = refine;
        tile.refine = tile.__hasRenderableContent ? refine : "ADD";
    }
    // Release replacement dependencies outside the current view. On an
    // overlay the native globe is already a valid fallback on newly exposed
    // edges. Keep the complete hierarchy for the next camera position.
    ensureChildrenArePreprocessed(tile) {
        super.ensureChildrenArePreprocessed(tile);
        if (
            !this.branches ||
            !this.cameraInfo[0] ||
            tile.children.length < 2 ||
            this.branches.has(tile)
        )
            return;
        const children = tile.children,
            nearby = children.filter(child => this.tileInView(child));
        if (nearby.length !== children.length) {
            this.branches.set(tile, children);
            tile.children = nearby;
        }
    }
    update() {
        this.branches = new Map();
        try {
            super.update();
        } finally {
            for (const [tile, children] of this.branches) tile.children = children;
            this.branches = undefined;
        }
        for (const tile of this.activeTiles) {
            if (tile.__lastFrameVisited === this.frameCount && tile.__used) continue;
            if (tile.__wasSetVisible) {
                this.setTileVisible(tile, false);
                tile.__wasSetVisible = false;
            }
            this.setTileActive(tile, false);
            tile.__wasSetActive = false;
            tile.__usedLastFrame = false;
        }
    }
    setTileVisible(tile, visible) {
        super.setTileVisible(tile, visible);
        if (visible && this.progressive) tile.surveyWasDrawn = true;
    }
    calculateError(tile) {
        super.calculateError(tile);
        if (this.focus) {
            // The central viewing footprint gets its first usable model before
            // a large ring of peripheral siblings. Coarse parents still follow
            // the source hierarchy within each projected-distance band.
            const distance = tile.cached.boundingVolume.distanceToPoint(this.focus);
            tile.surveyFocusBand = Math.floor(Math.log2(1 + distance / this.focusWidth));
        }
        // A coarse model already on screen is a valid replacement parent.
        // Keep traversing toward the native error target, while allowing the
        // ready parent to stay visible until its own children can cover it.
        if (this.progressive && tile.surveyWasDrawn && tile.cached.scene) {
            tile.__error = Math.min(tile.__error, (this.errorTarget + 1) * this.errorThreshold);
        }
    }
    tileInView(tile) {
        return (
            super.tileInView(tile) &&
            tile.cached.boundingVolume.distanceToPoint(this.cameraInfo[0].position) <
                this.surveyRadius
        );
    }
}
function materialBytes(scene, maxSide) {
    const seen = new Set();
    let bytes = 0;
    scene.traverse(obj => {
        if (!obj.isMesh) return;
        for (const attr of Object.values(obj.geometry.attributes).concat(
            obj.geometry.index || []
        )) {
            const buffer = (attr.isInterleavedBufferAttribute ? attr.data : attr).array?.buffer;
            if (buffer && !seen.has(buffer)) {
                bytes += buffer.byteLength;
                seen.add(buffer);
            }
        }
        for (const mat of [].concat(obj.material)) {
            const tex = mat.map;
            if (!tex || seen.has(tex)) continue;
            seen.add(tex);
            const image = tex.image;
            if (Math.max(image.width, image.height) > maxSide) {
                const scale = maxSide / Math.max(image.width, image.height),
                    canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));
                const ctx = canvas.getContext("2d");
                if (ctx) {
                    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                    tex.image = canvas;
                    tex.needsUpdate = true;
                    image.close?.();
                }
            }
            bytes += Math.ceil(
                tex.image.width * tex.image.height * 4 * (tex.generateMipmaps ? 4 / 3 : 1)
            );
        }
    });
    return bytes;
}
export function createSurveyMesh(
    THREE,
    map,
    source,
    small,
    stats,
    surfacePages,
    sky,
    environment,
    budget
) {
    const sun = sky.uniforms.sunDirection;
    const tiles = new SurveyRenderer(new URL(source.url, location.href).href);
    tiles.budget = budget;
    tiles.progressive = source.continuous;
    tiles.focus = new THREE.Vector3();
    const fallbackMeshes = tiles.progressive ? fallback.photoFallback(THREE, tiles) : undefined;
    tiles.surveyRadius = small ? 2600 : 4200;
    const fineError = small ? 13 : 8;
    tiles.errorTarget = source.continuous ? 50 : fineError;
    tiles.errorThreshold = 2.5;
    tiles.downloadQueue.maxJobs = small ? 2 : 3;
    tiles.parseQueue.maxJobs = 1;
    tiles.lruCache.minSize = small ? 55 : 85;
    tiles.lruCache.maxSize = small ? 220 : 420;
    tiles.lruCache.minBytesSize = (small ? 40 : 72) * 1024 * 1024;
    tiles.lruCache.maxBytesSize = (small ? 84 : 155) * 1024 * 1024;
    const abort = new AbortController();
    tiles.fetchOptions = { signal: abort.signal };
    const draco = new DRACOLoader().setDecoderPath("resources/earth/draco/").setWorkerLimit(1);
    const loader = new GLTFLoader(tiles.manager)
        .setDRACOLoader(draco)
        .setMeshoptDecoder(MeshoptDecoder);
    const photos =
        source.photo && typeof createImageBitmap === "function"
            ? photoTextures.surveyTextures(small, tiles, stats, wake)
            : undefined;
    if (photos) loader.register(photos.register);
    if (source.legacy) {
        const parse = loader.parse.bind(loader);
        loader.parse = (data, path, onLoad, onError) => {
            try {
                parse(legacy.upgradePhotoGlb(data), path, onLoad, onError);
            } catch (error) {
                onError(error);
            }
        };
    }
    loader.register(() => new GLTFCesiumRTCExtension());
    tiles.manager.addHandler(/\.gltf$/i, loader);
    const camera = new THREE.PerspectiveCamera(),
        resolution = new THREE.Vector2();
    tiles.setCamera(camera);
    tiles.group.matrixAutoUpdate = false;
    map.scene.add(tiles.group);
    let disposed = false,
        previousLat = Infinity,
        previousLon = Infinity,
        transform;
    let needsTraversal = true;
    const lastCamera = new THREE.Matrix4(),
        lastProjection = new THREE.Matrix4(),
        lastSize = new THREE.Vector2(),
        sphere = new THREE.Sphere();
    const visibility = { value: 1 },
        clipRange = { value: 3000 },
        eye = new THREE.Vector3(),
        inverse = new THREE.Matrix4();
    function wake() {
        needsTraversal = true;
        if (!disposed) map.update();
    }
    tiles.surveyWake = wake;
    for (const event of ["load-content", "load-model", "tile-visibility-change", "tiles-load-end"])
        tiles.addEventListener(event, wake);
    tiles.addEventListener("load-model", ({ scene, tile }) => {
        tile.cached.boundingVolume.getSphere(sphere);
        if (photos) tile.cached.photoBounds = sphere.clone();
        const info = tiles.cameraInfo[0];
        const distance = sphere.center.distanceTo(info.position);
        const pixels = (2 * sphere.radius) / (Math.max(10, distance) * info.sseDenominator);
        const side = Math.min(
            small ? 384 : 512,
            Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, pixels))))
        );
        tile.cached.bytesUsed = materialBytes(scene, side);
        const roofStyle = source.continuous
            ? undefined
            : styles.surveyRoofStyle(
                  THREE,
                  map,
                  tiles.ellipsoid.getPositionToCartographic(sphere.center, {}),
                  surfacePages,
                  sun,
                  source.photo
              );
        scene.renderOrder = -10;
        scene.traverse(mesh => {
            mesh.renderOrder = -10;
            if (!mesh.isMesh) return;
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            if (roofStyle) {
                mesh.onBeforeRender = roofStyle.bind;
                mesh.onAfterRender = roofStyle.release;
            }
            for (const m of materials) {
                if (m.userData.earthSurvey) continue;
                m.userData.earthSurvey = true;
                if (source.photo && !m.map && m.opacity === 0) {
                    m.visible = false;
                    continue;
                }
                m.stencilWrite = true;
                m.stencilRef = 64;
                m.stencilWriteMask = 64;
                m.stencilZPass = THREE.ReplaceStencilOp;
                m.stencilFunc = THREE.AlwaysStencilFunc;
                m.onBeforeCompile = shader => {
                    shader.fragmentShader = shader.fragmentShader.replace(
                        "#include <output_fragment>",
                        "outgoingLight=surveyLight(diffuseColor.rgb,-1.);\n#include <output_fragment>"
                    );
                };
                if (roofStyle) {
                    m.onBeforeCompile = roofStyle.attach;
                    m.extensions = { ...m.extensions, derivatives: true };
                }
                const applyStyle = m.onBeforeCompile;
                m.onBeforeCompile = shader => {
                    applyStyle(shader);
                    lighting.attachSurveyLight(shader, sky, environment);
                    shader.uniforms.surveyVisibility = visibility;
                    shader.uniforms.surveyClip = clipRange;
                    shader.fragmentShader =
                        "uniform float surveyVisibility,surveyClip;\n" +
                        shader.fragmentShader.replace(
                            "#include <output_fragment>",
                            `
                        float weight=surveyVisibility*(1.-smoothstep(.72*surveyClip,surveyClip,length(surveyRelative)*1000.));
                        if(weight<1. && fract(52.9829189*fract(dot(floor(gl_FragCoord.xy),vec2(.06711056,.00583715))))>weight)discard;
                        #include <output_fragment>
                    `
                        );
                };
                m.customProgramCacheKey = () => source.id;
                if (source.photo && m.map) {
                    tile.cached.hasPhoto = true;
                    m.transparent = false;
                    m.opacity = 1;
                }
                if (!source.photo && !m.map) m.color?.setHex(0xcdbea8);
            }
        });
    });
    let lastTraversalTime = 0,
        settleTimer,
        qualityTimer,
        firstContent = 0;
    const lastEye = new THREE.Vector3(),
        lastRotation = new THREE.Quaternion();
    return {
        update(day) {
            const lastVisibility = visibility.value;
            visibility.value =
                (source.continuous ? THREE.MathUtils.smoothstep(day, -0.075, 0.105) : 1) *
                THREE.MathUtils.smoothstep(map.zoomLevel, 12.4, 13.1);
            if (Math.abs(lastVisibility - visibility.value) > 0.001) needsTraversal = true;
            clipRange.value = tiles.surveyRadius = Math.min(
                small ? 3000 : 4500,
                Math.max(1700, 4.8 * map.targetDistance)
            );
            const now = performance.now();
            if (source.continuous && tiles.visibleTiles.size) {
                firstContent ||= now;
                const age = now - firstContent;
                const goal = age < 1900 ? 50 : age < 5200 ? 23 : fineError;
                if (tiles.errorTarget !== goal) {
                    tiles.errorTarget = goal;
                    needsTraversal = true;
                }
                if (!qualityTimer && age < 5200)
                    qualityTimer = setTimeout(
                        () => {
                            qualityTimer = undefined;
                            wake();
                        },
                        Math.min(5200 - age, age < 1900 ? 1900 - age : 5200 - age) + 10
                    );
            }
            if (lastTraversalTime) {
                const dt = Math.max(0.016, Math.min(0.25, (now - lastTraversalTime) / 1000));
                if (
                    lastEye.distanceTo(map.camera.position) >
                        Math.max(12, 0.26 * map.targetDistance * dt) ||
                    lastRotation.angleTo(map.camera.quaternion) > 0.9 * dt
                ) {
                    tiles.deferUntil = now + 135;
                    clearTimeout(settleTimer);
                    settleTimer = setTimeout(wake, 140);
                }
            }
            lastTraversalTime = now;
            lastEye.copy(map.camera.position);
            lastRotation.copy(map.camera.quaternion);
            map.renderer.getDrawingBufferSize(resolution);
            if (
                !needsTraversal &&
                lastCamera.equals(map.camera.matrixWorld) &&
                lastProjection.equals(map.camera.projectionMatrix) &&
                lastSize.equals(resolution)
            )
                return;
            needsTraversal = false;
            lastCamera.copy(map.camera.matrixWorld);
            lastProjection.copy(map.camera.projectionMatrix);
            lastSize.copy(resolution);
            const { latitude: lat, longitude: lon } = map.target;
            if (Math.abs(lat - previousLat) + Math.abs(lon - previousLon) > 0.008) {
                transform = surveyTransform(
                    THREE,
                    lat,
                    lon,
                    source.orthometric ? 0 : geoidHeight(lat, lon)
                );
                previousLat = lat;
                previousLon = lon;
            }
            // Select in a rigid ECEF frame. Keep the surveyed camera position
            // exact, then restore the ellipsoid differential for drawing.
            eye.copy(map.camera.position).applyMatrix4(inverse.copy(transform).invert());
            map.projection.projectPoint(map.target, tiles.focus).applyMatrix4(inverse);
            tiles.focusWidth = Math.max(50, map.targetDistance * 0.33);
            tiles.group.matrix.makeTranslation(-eye.x, -eye.y, -eye.z);
            tiles.group.matrixWorld.copy(tiles.group.matrix);
            const setDrawTransform = () => {
                tiles.group.matrix.copy(transform);
                const el = tiles.group.matrix.elements,
                    p = map.camera.position;
                el[12] -= p.x;
                el[13] -= p.y;
                el[14] -= p.z;
                tiles.group.updateMatrixWorld(true);
            };
            camera.quaternion.copy(map.camera.quaternion);
            camera.projectionMatrix.copy(map.camera.projectionMatrix);
            camera.projectionMatrixInverse.copy(map.camera.projectionMatrixInverse);
            camera.updateMatrixWorld(true);
            map.renderer.getDrawingBufferSize(resolution);
            tiles.setResolution(camera, resolution.x, resolution.y);

            fallbackMeshes?.clear();
            tiles.update();
            stats.fallbackMeshes = fallbackMeshes?.update(map.targetDistance, camera) || 0;
            setDrawTransform();
            photos?.update();
            stats.visible = tiles.visibleTiles.size + stats.fallbackMeshes;
            stats.bytes = tiles.lruCache.cachedBytes;
            stats.transferred = tiles.networkBytes;
            stats.pending = tiles.stats.downloading + tiles.stats.parsing;
        },
        dispose() {
            disposed = true;
            fallbackMeshes?.clear();
            clearTimeout(settleTimer);
            clearTimeout(qualityTimer);
            tiles.surveyWake = undefined;
            abort.abort();
            tiles.group.removeFromParent();
            photos?.dispose();
            tiles.dispose();
            draco.dispose();
        }
    };
}
