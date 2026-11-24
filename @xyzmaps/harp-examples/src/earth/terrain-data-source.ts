import { earthWorkerUrl } from "./worker-url";
import * as THREE from "three";
import { DataProvider, TileDataSource, TileFactory } from "@xyzmaps/harp-mapview-decoder";
import type { ITileDecoder } from "@xyzmaps/harp-datasource-protocol";
import { Tile, DataSource, MapViewUtils, ConcurrentDecoderFacade } from "@xyzmaps/harp-mapview";
import { GeoCoordinates, TileKey, webMercatorTilingScheme } from "@xyzmaps/harp-geoutils";
import type { TileKeyEntry } from "@xyzmaps/harp-mapview/lib/FrustumIntersection";
import { retreatTargets } from "./terrain-transition";
import { createTerrainStream } from "./terrain-stream";
import { regionalFallbackCut, selectTerrainTiles } from "./terrain-selection";
import { terrainTopology } from "./terrain-sample";
import { gridWidth } from "./terrain-grid";
import { cropParentSurface, parentPatchLayout } from "./terrain-parent";
import { fetchTerrain } from "./math";
import { TerrainPack, DETAIL_BASE } from "./terrain-pack";
import type { WorldTerrain } from "./world-terrain";
import { TerrainBaseline, type ReliefPayload } from "./terrain-baseline";
import { TileRepairs } from "./tile-repairs";
import { TerrainEndpoint } from "./terrain-endpoint";
import { isRasterError } from "./terrain-raster-error";
export const supportsWorldTerrain = () =>
    typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
export const loadWorldTerrain = async () =>
    (await import(/* webpackChunkName: "earth-open-terrain" */ "./world-terrain")).WorldTerrain;

class TerrainProvider extends DataProvider {
    readonly openOcean = new WeakSet<TileKey>();
    private readonly repairs = new TileRepairs(codes => {
        this.health.repairAttempts += codes.size;
        this.repair?.(codes);
    });
    pack?: TerrainPack;
    world?: WorldTerrain;
    get globalBase() {
        return !this.token || (!!this.world && this.endpoint.paused);
    }
    fallback?: (key: TileKey, maxLevel?: number) => object;
    repair?: (codes: Set<number>) => void;
    private transferMs?: number;
    readonly endpoint = new TerrainEndpoint();
    readonly baseline = new TerrainBaseline();
    private async availableSurface(key: TileKey, signal?: AbortSignal, repair = false, remoteFailure = false) {
        const surface = this.fallback?.(key) as { sourceLevel?: number } | undefined;
        if ((surface?.sourceLevel ?? -1) >= Math.min(6, key.level) || !supportsWorldTerrain())
            return surface ?? { kind: "sea-level-fallback" };
        try {
            const relief = await this.baseline.read(key, signal, repair);
            if (!remoteFailure) this.repairs.success(key.mortonCode());
            return relief ?? surface ?? { kind: "sea-level-fallback" };
        } catch (error) {
            if (signal?.aborted) throw error;
            if (!remoteFailure) this.repairs.failed(key.mortonCode());
            return surface ?? { kind: "sea-level-fallback" };
        }
    }
    private heldSurface(key: TileKey, signal: AbortSignal | undefined, repair: boolean) {
        this.endpoint.held.add(key);
        this.openOcean.delete(key);
        this.health.fallbackTiles++;
        return this.availableSurface(key, signal, repair);
    }
    readonly health = { fallbackTiles: 0, repairAttempts: 0, constrained: false };
    constructor(private token: string) {
        super();
    }
    ready() {
        return true;
    }
    protected connect() {
        this.repairs.connect();
        return Promise.resolve();
    }
    protected dispose() {
        this.baseline.dispose();
        this.endpoint.dispose();
        this.repairs.dispose();
    }
    createDecoder(): ITileDecoder {
        const worker = ConcurrentDecoderFacade.getTileDecoder("png_decoder_service", earthWorkerUrl("earth-decoder"));
        const decodeFallback = async (...args: Parameters<ITileDecoder["decodeTile"]>) => {
            const [payload, key, projection, controller] = args;
            if (!("kind" in payload) || payload.kind !== "bundled-relief")
                return worker.decodeTile(payload, key, projection, controller);
            try {
                return await worker.decodeTile(payload, key, projection, controller);
            } catch (error) {
                if (controller?.signal.aborted || !isRasterError(error)) throw error;
                await this.baseline.rejectPage(payload as ReliefPayload);
                this.repairs.failed(key.mortonCode());
                const parent = this.fallback?.(key) ?? { kind: "sea-level-fallback" };
                return worker.decodeTile(parent, key, projection, controller);
            }
        };
        return {
            connect: () => worker.connect(),
            dispose: () => worker.dispose(),
            configure: (options, custom) => worker.configure(options, custom),
            getTileInfo: (...args) => worker.getTileInfo(...args),
            decodeTile: async (data, key, projection, controller) => {
                const kind = "kind" in data ? data.kind : undefined;
                const raster = data instanceof ArrayBuffer || kind === "terrarium-webp" || kind === "terrain-detail" || kind === "terrain-pack-raster";
                if (!raster) return decodeFallback(data, key, projection, controller);
                try {
                    const decoded = await worker.decodeTile(data, key, projection, controller);
                    if (!controller?.signal.aborted) this.repairs.success(key.mortonCode());
                    return decoded;
                } catch (error) {
                    if (controller?.signal.aborted || !isRasterError(error)) throw error;
                    // A successful HTTP response can still contain a CDN error page
                    // or a damaged image. Retain terrain coverage and repair it just
                    // as for a transfer failure. Keep decoder failures on fallback
                    // geometry visible to the regular loader.
                    if (kind === "terrarium-webp" && "page" in data && typeof data.page === "number")
                        this.world?.rejectPage(data.page);
                    const fallback = await this.failedSurface(key, controller?.signal);
                    return decodeFallback(fallback, key, projection, controller);
                }
            }
        };
    }
    private failedSurface(key: TileKey, signal?: AbortSignal) {
        this.openOcean.delete(key);
        this.health.fallbackTiles++;
        const repair = this.repairs.pending(key.mortonCode());
        this.repairs.failed(key.mortonCode());
        return this.availableSurface(key, signal, repair, true);
    }
    async getTile(key: TileKey, signal?: AbortSignal) {
        try {
            const start = performance.now();
            const repair = this.repairs.pending(key.mortonCode());
            const kind = key.level > DETAIL_BASE ? this.pack?.availability(key) : 0;
            if (kind) {
                // Hold the actual parent while the detail tile is in flight.
                const parent = kind !== 1 ? this.fallback?.(key, DETAIL_BASE) : undefined;
                const raster = await this.pack!.read(key, signal, repair);
                return kind === 1
                    ? { kind: "terrain-pack-raster", raster }
                    : {
                          kind: "terrain-detail",
                          raster,
                          parent,
                          edgeDistancePixels: this.pack!.edgeDistancePixels
                      };
            }
            // Keep the normal base through its native limit. Beyond it the world
            // directory admits only branches with published higher-detail data.
            if (this.world && (this.globalBase || key.level > DETAIL_BASE)) {
                try {
                    const open = await this.world.read(key, this.globalBase, signal, repair);
                    if (open) {
                        if (this.token && this.endpoint.cooling && key.level <= DETAIL_BASE)
                            this.endpoint.held.add(key);
                        this.openOcean.delete(key);
                        return open;
                    }
                } catch (error) {
                    if (signal?.aborted) throw error;
                    if (this.globalBase || key.level > DETAIL_BASE) {
                        if (this.world.endpoint.held.has(key))
                            return this.availableSurface(key, signal, repair);
                        throw error;
                    }
                    // An unavailable optional survey can fall back to the regular source.
                }
            }
            if (key.level > DETAIL_BASE || !this.token)
                return this.availableSurface(key, signal, repair);
            let payload;
            try {
                payload = await this.endpoint.fetch(
                    () => fetchTerrain(key, this.token, signal, repair),
                    signal
                );
                this.endpoint.held.delete(key);
            } catch (error) {
                if (!signal?.aborted && this.endpoint.cooling) {
                    this.endpoint.held.add(key);
                    // The open elevation pyramid also covers base tiles if the
                    // configured paid endpoint temporarily refuses the browser.
                    if (this.world && key.level <= DETAIL_BASE) {
                        const open = await this.world.read(key, true, signal, repair);
                        if (open) return open;
                    }
                    return this.heldSurface(key, signal, repair);
                }
                throw error;
            }
            if (payload instanceof ArrayBuffer && payload.byteLength >= 16_384) {
                const elapsed = Math.min(5000, performance.now() - start);
                this.transferMs =
                    this.transferMs === undefined
                        ? elapsed
                        : 0.75 * this.transferMs + 0.25 * elapsed;
                // Too many downloads at once delay the patch under the pointer
                // on shared connections. Hysteresis avoids switching every tile.
                if (this.transferMs > 500) this.health.constrained = true;
                else if (this.transferMs < 250) this.health.constrained = false;
            }
            if ("kind" in payload && payload.kind === "empty-ocean-dem") {
                this.openOcean.add(key);
                this.repairs.success(key.mortonCode());
            } else this.openOcean.delete(key);
            return payload;
        } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
                throw error;
            return this.failedSurface(key, signal);
        }
    }
}
class TangentTile extends Tile {
    constructor(source: DataSource, key: TileKey) {
        super(source, key, 0, true);
    }
}
export class EarthTerrainDataSource extends TileDataSource<TangentTile> {
    stationaryTileSelectionRevision = 0;
    private readonly terrainProvider: TerrainProvider;
    constructor(
        token: string,
        packUrl?: URL,
        World?: typeof WorldTerrain
    ) {
        const provider = new TerrainProvider(token);
        super(new TileFactory(TangentTile), {
            name: "terrain",
            tilingScheme: webMercatorTilingScheme,
            dataProvider: provider,
            decoder: provider.createDecoder(),
            minDataLevel: 0,
            maxDataLevel: 15,
            minGeometryHeight: -500,
            maxGeometryHeight: 9000,
            dataSourceOrder: -1
        });
        this.terrainProvider = provider;
        provider.endpoint.changed = this.coverageChanged;
        if (packUrl) provider.pack = new TerrainPack(packUrl, this.coverageChanged);
        if (World) this.enableWorld(World);
        provider.fallback = (key, maxLevel) => this.parentSurface(key, maxLevel);
        provider.endpoint.refresh = single => this.refreshHeld(provider.endpoint, single);
        provider.repair = codes => {
            if (this.isDetached()) return;
            this.mapView.markTilesDirty(this, tile => codes.has(tile.tileKey.mortonCode()));
            this.requestUpdate();
        };
    }
    private readonly coverageChanged = () => {
        const provider = this.terrainProvider;
        this.maxDataLevel =
            provider.world || provider.pack?.stats.indexedRegions ? 17 : DETAIL_BASE;
        this.stationaryTileSelectionRevision++;
        if (!this.isDetached()) this.requestUpdate();
    };
    private enableWorld(World: typeof WorldTerrain) {
        const world = new World(this.coverageChanged);
        this.terrainProvider.world = world;
        world.endpoint.refresh = single => this.refreshHeld(world.endpoint, single);
        this.maxDataLevel = 17;
    }
    private refreshHeld(endpoint: TerrainEndpoint, single: boolean) {
        if (this.isDetached()) return;
        const view = this.mapView;
        // Revisit one visible failure to test recovery. Once healthy, refill
        // a few at a time so a stationary camera cannot burst 100 requests.
        const entry = view.visibleTileSet.dataSourceTileList.find(e => e.dataSource === this);
        const visible = new Set<TileKey>();
        for (const tile of entry?.visibleTiles ?? []) visible.add(tile.tileKey);
        for (const tile of entry?.renderedTiles.values() ?? []) visible.add(tile.tileKey);
        const chosen = new Set<TileKey>();
        let remaining = false;
        for (const key of visible) {
            if (!endpoint.held.has(key)) continue;
            if (chosen.size >= (single ? 1 : 4)) {
                remaining = true;
                break;
            }
            chosen.add(key);
            endpoint.held.delete(key);
        }
        if (chosen.size || !single) {
            view.markTilesDirty(
                this,
                tile =>
                    chosen.has(tile.tileKey) ||
                    (!single && !visible.has(tile.tileKey) && endpoint.held.has(tile.tileKey))
            );
        }
        if (!single && remaining && !endpoint.paused) endpoint.queue(false, 150);
        this.requestUpdate();
    }
    get terrainBaseline() {
        return this.terrainProvider.baseline.stats;
    }
    get terrainHealth() {
        return this.terrainProvider.health;
    }
    get worldTerrain() {
        return this.terrainProvider.world?.stats;
    }
    get terrainDetail() {
        return this.terrainProvider.pack?.stats;
    }
    openingTiles?: TileKey[];
    private foregroundFrame = -1;
    private foregroundZoom = 0;
    private foregroundActive = false;
    private surveyRange = false;
    private foregroundFocus?: GeoCoordinates;
    private readonly lookDirection = new THREE.Vector3();
    getDataZoomLevel(zoomLevel: number) {
        const level = super.getDataZoomLevel(zoomLevel);
        if (this.isDetached()) return level;
        const map = this.mapView;
        if (this.foregroundFrame !== map.frameNumber) {
            this.foregroundFrame = map.frameNumber;
            // Reserve cross-provider detail for close inspection. A grazing
            // camera can request high zooms several kilometres from its target.
            this.surveyRange = map.targetDistance < (this.surveyRange ? 2200 : 1800);
            const previousZoom = this.foregroundZoom;
            const wasActive = this.foregroundActive;
            this.foregroundActive = false;
            this.foregroundZoom = 0;
            this.foregroundFocus = undefined;
            const eye = map.camera.position;
            const radius = eye.length();
            const altitude = radius - this.projection.unitScale;
            if (level < this.maxDataLevel && altitude < 15000 && radius > 0) {
                const geo = this.projection.unprojectPoint(eye);
                const ground = map.elevationProvider?.getHeight(geo, DETAIL_BASE) ?? 0;
                const direction = map.camera.getWorldDirection(this.lookDirection);
                const downward = -direction.dot(eye) / radius;
                // The true center hit can be kilometers across a canyon. Near
                // terrain in the lower viewport still projects to many pixels.
                const range = Math.max(20, altitude - ground) / Math.max(0.2, downward);
                if (range * (wasActive ? 1.35 : 1.5) < map.targetDistance) {
                    this.foregroundActive = true;
                    const zoom = MapViewUtils.calculateZoomLevelFromDistance(map, range);
                    this.foregroundZoom = wasActive && zoom >= previousZoom - 0.18 && zoom < previousZoom + 1.18
                        ? previousZoom : Math.floor(zoom);
                    this.foregroundFocus = this.projection.unprojectPoint(
                        direction.multiplyScalar(range).add(eye)
                    );
                }
            }
        }
        const wanted = Math.max(level, super.getDataZoomLevel(this.foregroundZoom));
        return this.surveyRange ? wanted : Math.min(DETAIL_BASE, wanted);
    }
    shouldSubdivide(zoom: number, key: TileKey) {
        const source = this.terrainProvider;
        if (key.level < DETAIL_BASE) {
            if (!super.shouldSubdivide(zoom, key)) return false;
            return !source.globalBase || !source.world || source.world.canRefine(key);
        }
        return (
            key.level < zoom &&
            key.level < 17 &&
            (!!source.pack?.canRefine(key) || !!source.world?.canRefine(key))
        );
    }
    private parentSurface(child: TileKey, maxLevel = Infinity) {
        if (!this.isDetached())
            for (let key = child; key.level > 0;) {
                key = key.parent();
                if (key.level > maxLevel) continue;
                const tile = this.mapView.visibleTileSet.getCachedTile(
                    this,
                    key,
                    0,
                    this.mapView.frameNumber
                );
                const mesh = tile?.objects.find(o => (o as THREE.Mesh).isMesh) as
                    THREE.Mesh | undefined;
                const position = mesh?.geometry.attributes.position;
                if (!tile || tile.disposed || !position || !("isBufferAttribute" in position))
                    continue;
                const width = gridWidth(mesh!.geometry);
                if (!Number.isInteger(width)) continue;
                // The worker receives a structured clone without detaching the drawable tile.
                return this.surface(tile, mesh!, width);
            }
        return { kind: "sea-level-fallback" };
    }
    private surface(tile: Tile, mesh: THREE.Mesh, width = gridWidth(mesh.geometry), shade = false) {
        const transition = mesh.geometry.userData.terrainTransition;
        const normal = shade ? mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined : undefined;
        return {
            kind: "parent-terrain-surface",
            terrainProvider: mesh.geometry.userData.attributeMetadata?.position?.terrainProvider,
            sourceLevel: mesh.geometry.userData.attributeMetadata?.position?.terrainSourceLevel ?? tile.tileKey.level,
            width,
            positions: (mesh.geometry.attributes.position as THREE.BufferAttribute).array,
            topology: terrainTopology(mesh.geometry),
            diagonal: mesh.geometry.userData.attributeMetadata?.position?.terrainDiagonal,
            // Worker elevation fallbacks need only the position offsets. Main-thread
            // crops inherit the visible normal field without cloning extra buffers.
            morph: shade || !transition ? transition : { delta: transition.delta, factor: transition.factor },
            normals: normal?.array,
            normalScale: normal?.array instanceof Int16Array ? 1 / 32767 : 1,
            matrix: tile.boundingBox.getRotationMatrix().setPosition(tile.center).toArray(),
            level: tile.tileKey.level,
            column: tile.tileKey.column,
            row: tile.tileKey.row
        };
    }
    private readonly cropped = new Map<number, { tile: Tile; source: THREE.BufferGeometry }>();
    private cropTile(key: TileKey, parentKey: TileKey) {
        const frame = this.mapView.frameNumber;
        const parent = this.mapView.visibleTileSet.getCachedTile(this, parentKey, 0, frame);
        const source = parent?.objects.find(object => (object as THREE.Mesh).isMesh) as
            THREE.Mesh | undefined;
        if (!parent || !source) return;
        const code = key.mortonCode(),
            old = this.cropped.get(code);
        if (old?.source === source.geometry) {
            old.tile.frameNumLastRequested = frame;
            return old.tile;
        }
        old?.tile.dispose();
        const tile = new TangentTile(this, key);
        const surface = this.surface(parent, source, gridWidth(source.geometry), true);
        const layout = parentPatchLayout(surface, key);
        const patch = cropParentSurface(
            surface,
            key,
            tile.boundingBox,
            layout.width,
            this.projection.unitScale,
            layout.skirtVertices
        );
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(patch.positions, 3));
        if (patch.normals)
            geometry.setAttribute("normal", new THREE.BufferAttribute(patch.normals, 3, true));
        geometry.setAttribute("uv", new THREE.BufferAttribute(layout.uv, 2, true));
        geometry.setIndex(new THREE.BufferAttribute(layout.index, 1));
        geometry.userData.attributeMetadata = {
            position: {
                terrainGridWidth: layout.width,
                terrainSurfaceNormals: patch.normals ? 1 : 0,
                terrainSourceLevel: surface.sourceLevel,
                terrainProvider: surface.terrainProvider,
                terrainDiagonal: layout.diagonal,
                minHeight: patch.minHeight,
                maxHeight: patch.maxHeight
            }
        };
        const mesh = new THREE.Mesh(
            geometry,
            this.createTileMaterial(tile, source.userData.technique)
        );
        mesh.userData.tileKey = key;
        mesh.userData.terrainCropLevel = parentKey.level;
        mesh.renderOrder = source.renderOrder;
        tile.objects.push(mesh);
        tile.frameNumLastRequested = frame;
        this.cropped.set(code, { tile, source: source.geometry });
        return tile;
    }
    isOpenOcean(key: TileKey) {
        return this.terrainProvider.openOcean.has(key);
    }
    diagnostic?: {
        holdTerrain: boolean; prefetchOff: boolean; frame?: number;
        candidates?: TileKeyEntry[]; desired?: TileKeyEntry[]; requests?: TileKeyEntry[];
    };
    private readonly previousSplits = new Set<number>();
    private selection?: {
        entries: TileKeyEntry[];
        limit: number;
        usedFeedback: boolean;
        tiles: TileKeyEntry[];
    };
    selectBudgetedTiles(entries: TileKeyEntry[], limit: number): TileKeyEntry[] {
        const map = this.mapView;
        if (this.diagnostic) {
            this.diagnostic.frame = map.frameNumber;
            this.diagnostic.candidates = entries;
        }
        const survey =
            !!(this.terrainProvider.pack || this.terrainProvider.world) &&
            entries.some(e => e.tileKey.level > DETAIL_BASE);
        // Smaller device budgets can otherwise spend every slot on distant patches
        // while a single coarse tile owns nearly the entire foreground.
        const prioritize = survey || entries.some(e => e.tileKey.level >= 13);
        const visibleShare = prioritize
            ? this.stream.visibleShare(map, performance.now())
            : undefined;
        const cached = this.selection;
        if (
            cached?.entries === entries &&
            cached.limit === limit &&
            (!visibleShare || cached.usedFeedback)
        )
            return cached.tiles;
        const tiles = selectTerrainTiles(
            entries,
            limit,
            prioritize ? (this.foregroundFocus ?? map.target) : undefined,
            visibleShare,
            survey,
            this.previousSplits
        );
        this.previousSplits.clear();
        if (prioritize) for (const entry of tiles) {
            let key = entry.tileKey;
            while (key.level > 0) {
                key = key.parent();
                const id = key.mortonCode();
                if (this.previousSplits.has(id)) break;
                this.previousSplits.add(id);
            }
        }
        this.selection = { entries, limit, tiles, usedFeedback: !!visibleShare };
        return tiles;
    }
    private readonly stream = createTerrainStream(
        () => this.terrainProvider.health.constrained || !!this.terrainProvider.world?.constrained,
        DETAIL_BASE
    );
    updateTerrainFeedback(
        samples: Array<{ mx: number; my: number; ndcX: number; ndcY: number }>,
        now: number
    ) {
        this.stream.setFeedback(this.mapView, samples, now);
    }
    // Keep a complete, opaque cover while the outgoing children approach their
    // parent's elevation. Missing quadrants use the existing parent crop path.
    private retreats = new Map<Tile, { parent: Tile; start: number }>();
    private retiringMeshes = new Set<THREE.Mesh>();
    private smoothRetreat(rendered: Array<Tile | TileKeyEntry>, last: Tile[], now: number) {
        for (const mesh of this.retiringMeshes) retreatTargets.delete(mesh);
        this.retiringMeshes.clear();
        const families = new Map<number, Map<number, Tile>>();
        for (const child of last) {
            if (child.disposed || child.tileKey.level < 9) continue;
            const id = child.tileKey.parent().mortonCode();
            let group = families.get(id);
            if (!group) families.set(id, group = new Map());
            group.set(child.tileKey.mortonCode(), child);
        }
        const next = new Map<Tile, { parent: Tile; start: number }>();
        const cover: Array<Tile | TileKeyEntry> = [];
        const frame = this.mapView.frameNumber;
        // Finish already visible blends first when budget sorting changes as the
        // camera tilts. Preserve the incoming order for all other candidates.
        const continuing = new Set(Array.from(this.retreats.keys(), t => t.tileKey.mortonCode()));
        const ordered = continuing.size
            ? [...rendered.filter(e => continuing.has(e.tileKey.mortonCode())),
               ...rendered.filter(e => !continuing.has(e.tileKey.mortonCode()))]
            : rendered;
        const groups = this.mapView.visibleTileSet.getNumberOfVisibleTiles() <= 65
            ? 2 : Math.max(2, Math.min(5, Math.ceil(this.mapView.canvas.height / 640)));
        for (const entry of ordered) {
            const key = entry.tileKey;
            const children = families.get(key.mortonCode());
            const parent = children && !(entry instanceof Tile) && !("cropFrom" in entry)
                ? this.mapView.visibleTileSet.getCachedTile(this, key, 0, frame) : undefined;
            const retreat = parent && (this.retreats.get(parent) ?? { parent, start: now + 120 });
            const finished = retreat && now >= retreat.start && children &&
                Array.from(children.values()).every(child => {
                    const morph = (child.objects[0] as THREE.Mesh | undefined)?.geometry.userData.terrainTransition;
                    return !morph || morph.atParent;
                });
            if (!parent || !children || !retreat || finished || next.size >= groups) {
                cover.push(entry);
                continue;
            }
            const parts: Tile[] = [];
            for (let i = 0; i < 4; i++) {
                const k = TileKey.fromRowColumnLevel(key.row * 2 + (i >> 1), key.column * 2 + (i & 1), key.level + 1);
                const part = children.get(k.mortonCode()) ?? this.cropTile(k, key);
                if (part) parts.push(part);
            }
            if (parts.length !== 4) {
                cover.push(entry);
                continue;
            }
            for (const part of parts) {
                part.frameNumLastRequested = frame;
                const mesh = part.objects[0] as THREE.Mesh;
                if (mesh && mesh.userData.terrainCropLevel !== key.level) {
                    retreatTargets.set(mesh, retreat);
                    this.retiringMeshes.add(mesh);
                }
            }
            next.set(parent, retreat);
            cover.push(...parts);
        }
        this.retreats = next;
        if (!next.size) return rendered;
        this.mapView.update();
        return cover;
    }
    planTileRequests(
        desired: TileKeyEntry[],
        state: (key: TileKey, offset: number) => "ready" | "pending" | undefined,
        previous: Iterable<Tile>
    ) {
        const provider = this.terrainProvider;
        const limited = provider.world
            ? provider.globalBase && provider.world.endpoint.paused
            : provider.endpoint.paused;
        const cut = limited && !provider.pack ? regionalFallbackCut(desired, state, 13) : desired;
        const last = Array.from(previous);
        const plan = this.stream.update(this.mapView, cut, state, last, undefined, !limited && !this.diagnostic?.prefetchOff, limited ? undefined : this.openingTiles);
        const debug = this.diagnostic;
        if (debug) {
            if (debug.frame !== this.mapView.frameNumber) debug.candidates = desired;
            debug.desired = cut;
            debug.requests = plan.requests;
            if (debug.holdTerrain) {
                plan.requests = plan.requests.filter((e: TileKeyEntry) => !!state(e.tileKey, e.offset));
            }
        }
        const cover = this.smoothRetreat(plan.rendered, last, performance.now());
        if (cover !== plan.rendered) {
            plan.complete = false;
            plan.rendered = cover;
        }
        if (!plan.complete) {
            plan.rendered = plan.rendered.flatMap(
                (entry: TileKeyEntry & { cropFrom?: TileKey }) => {
                    if (entry.cropFrom) return this.cropTile(entry.tileKey, entry.cropFrom) ?? [];
                    if (entry instanceof Tile)
                        entry.frameNumLastRequested = this.mapView.frameNumber;
                    return entry;
                }
            );
        }
        for (const [code, patch] of this.cropped) {
            if (patch.tile.frameNumLastRequested === this.mapView.frameNumber) continue;
            patch.tile.dispose();
            this.cropped.delete(code);
        }
        return plan;
    }
    dispose() {
        this.selection = undefined;
        this.stream.dispose();
        this.retreats.clear();
        for (const mesh of this.retiringMeshes) retreatTargets.delete(mesh);
        this.retiringMeshes.clear();
        this.terrainProvider.pack?.dispose();
        this.terrainProvider.world?.dispose();
        for (const patch of this.cropped.values()) patch.tile.dispose();
        this.cropped.clear();
        super.dispose();
    }
    async connect() {
        await super.connect();
        this.terrainProvider.pack?.connect();
        this.decoder.configure(
            {},
            {
                demEncoding: "terrainRgb",
                fillColor: "#182a36",
                elevationExaggeration: 1,
                widthSegments: 64,
                heightSegments: 64,
                continuousGrid: true,
                adaptiveDetail: true
            }
        );
    }
    shouldPreloadTiles() {
        return true;
    }
}
