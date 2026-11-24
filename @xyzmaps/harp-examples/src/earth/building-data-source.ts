import { earthWorkerUrl } from "./worker-url";
import { DataProvider, TileDataSource, TileFactory } from "@xyzmaps/harp-mapview-decoder";
import { Tile } from "@xyzmaps/harp-mapview";
import { DecodedTile, IndexedTechnique } from "@xyzmaps/harp-datasource-protocol";
import { TileKey, webMercatorTilingScheme } from "@xyzmaps/harp-geoutils";
import * as THREE from "three";
import { TileRepairs } from "./tile-repairs";
import { attachRoofTags } from "./roof-tags";
type RoofCatalog = ReturnType<typeof import("./roof-catalog").createRoofCatalog>;
export interface BuildingStats {
    shapedRoofs: number;
    tiles: number;
    buildings: number;
    pending: number;
    cache: number;
    cacheBytes: number;
    visibleBytes: number;
    requests: number;
    failures: number;
    active: boolean;
}
export interface BuildingStyle {
    create(tile: Tile): THREE.Material;
}
class BuildingProvider extends DataProvider {
    private template?: Promise<string>;
    roofShapes = false;
    private roofGeneration = 0;
    // Keep a bounded copy only while a late roof record may require a second
    // decode. The first buffer is transferred to harp's decoder worker.
    private pendingFootprints = new Map<number, ArrayBuffer>();
    private footprintBytes = 0;
    private takeFootprint(id: number) {
        const data = this.pendingFootprints.get(id);
        if (data) {
            this.pendingFootprints.delete(id);
            this.footprintBytes -= data.byteLength;
        }
        return data;
    }
    private rememberFootprint(id: number, data: ArrayBuffer) {
        if (data.byteLength > 1024 * 1024) return;
        this.takeFootprint(id);
        while (
            this.footprintBytes + data.byteLength > 4 * 1024 * 1024 ||
            this.pendingFootprints.size >= 24
        )
            this.takeFootprint(this.pendingFootprints.keys().next().value!);
        this.pendingFootprints.set(id, data.slice(0));
        this.footprintBytes += data.byteLength;
    }
    private roofCatalog?: Promise<RoofCatalog | undefined>;
    setRoofShapes(value: boolean) {
        this.roofShapes = value;
        this.roofGeneration++;
        this.pendingFootprints.clear();
        this.footprintBytes = 0;
        if (!value) {
            this.roofCatalog?.then(catalog => catalog?.dispose());
            this.roofCatalog = undefined;
        }
    }
    private roofRecord(key: TileKey) {
        if (!this.roofShapes) return;
        this.roofCatalog ??= import(/* webpackChunkName: "earth-roof-catalog" */ "./roof-catalog")
            .then(({ createRoofCatalog }) =>
                createRoofCatalog((codes: Set<number>) => this.repair?.(codes))
            )
            .catch(() => undefined);
        return this.roofCatalog.then(catalog => catalog?.get(key));
    }
    repair?: (codes: Set<number>) => void;
    private readonly repairs = new TileRepairs(codes => this.repair?.(codes));
    private disposed = false;
    private controllers = new Set<AbortController>();
    private waiters: Array<() => void> = [];
    constructor(private stats: BuildingStats) {
        super();
    }
    ready() {
        return true;
    }
    protected connect() {
        this.repairs.connect();
        return Promise.resolve();
    }
    // Share TileJSON across simultaneous near-city requests. Orbiting the
    // globe never needs the building provider's metadata.
    private async fetchTemplate(): Promise<string> {
        const controller = new AbortController();
        this.controllers.add(controller);
        try {
            const response = await fetch("https://tiles.openfreemap.org/planet", {
                signal: controller.signal
            });
            if (!response.ok) throw Error(`Building metadata HTTP ${response.status}`);
            const metadata = await response.json();
            if (this.disposed) throw new DOMException("Cancelled", "AbortError");
            return metadata.tiles[0];
        } finally {
            this.controllers.delete(controller);
        }
    }

    protected dispose() {
        this.disposed = true;
        this.setRoofShapes(false);
        this.repairs.dispose();
        for (const c of this.controllers) c.abort();
        for (const release of this.waiters.splice(0)) release();
    }
    async getTile(key: TileKey, signal?: AbortSignal): Promise<ArrayBuffer> {
        if (this.stats.pending >= 4) await new Promise<void>(resolve => this.waiters.push(resolve));
        if (this.disposed || signal?.aborted) {
            this.waiters.shift()?.();
            throw new DOMException("Cancelled", "AbortError");
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        this.controllers.add(controller);
        this.stats.pending++;
        const roofRecord = this.roofRecord(key),
            generation = this.roofGeneration,
            id = key.mortonCode();
        const withRoof = async (tile: ArrayBuffer) => {
            if (!roofRecord) return tile;
            const rec = await roofRecord;
            if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
            if (generation !== this.roofGeneration) return tile;
            if (rec?.data) return attachRoofTags(tile, rec.data);
            if (rec && !rec.done) {
                this.rememberFootprint(id, tile);
                rec.waiting.add(id);
            }
            return tile;
        };
        try {
            const footprint = this.takeFootprint(id);
            if (footprint) return await withRoof(footprint);
            for (let attempt = 0; ; attempt++) {
                this.stats.requests++;
                try {
                    this.template ??= this.fetchTemplate().catch(error => {
                        this.template = undefined;
                        throw error;
                    });
                    const template = await this.template;
                    const url = template
                        .replace("{z}", String(key.level))
                        .replace("{x}", String(key.column))
                        .replace("{y}", String(key.row));
                    const response = await fetch(url, { signal: controller.signal });
                    if (response.status === 404 || response.status === 410) {
                        this.repairs.success(key.mortonCode());
                        return new ArrayBuffer(0);
                    }
                    if (!response.ok) throw Error(`Building tile HTTP ${response.status}`);
                    const tile = await response.arrayBuffer();
                    this.repairs.success(key.mortonCode());
                    return await withRoof(tile);
                } catch (error) {
                    if (controller.signal.aborted) throw error;
                    this.stats.failures++;
                    if (attempt >= 2 || globalThis.navigator?.onLine === false) {
                        this.repairs.failed(key.mortonCode());
                        return new ArrayBuffer(0);
                    }
                    await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(done, 1000 * 2 ** attempt);
                        function done() {
                            controller.signal.removeEventListener("abort", cancel);
                            resolve();
                        }
                        function cancel() {
                            clearTimeout(timer);
                            reject(new DOMException("Cancelled", "AbortError"));
                        }
                        controller.signal.addEventListener("abort", cancel, { once: true });
                    });
                }
            }
        } finally {
            this.controllers.delete(controller);
            signal?.removeEventListener("abort", abort);
            this.stats.pending--;
            this.waiters.shift()?.();
        }
    }
}
class BuildingTile extends Tile {
    waterMask?: Uint8Array;
    get decodedTile(): DecodedTile | undefined {
        return super.decodedTile;
    }
    set decodedTile(value: DecodedTile | undefined) {
        if (value) this.waterMask = (value.tileInfo as { water?: Uint8Array } | undefined)?.water;
        super.decodedTile = value;
    }
}
export class BuildingsDataSource extends TileDataSource {
    readonly stationaryTileSelectionRevision = 0;
    readonly enableObjectFrustumCulling = true;
    readonly stats: BuildingStats;
    private readonly buildingProvider: BuildingProvider;
    setRoofShapes(value: boolean) {
        if (this.buildingProvider.roofShapes === value) return;
        this.buildingProvider.setRoofShapes(value);
        if (!this.isDetached()) {
            this.mapView.markTilesDirty(this);
            this.requestUpdate();
        }
    }
    constructor(private style: BuildingStyle) {
        const stats: BuildingStats = {
            shapedRoofs: 0,
            tiles: 0,
            buildings: 0,
            pending: 0,
            cache: 0,
            cacheBytes: 0,
            visibleBytes: 0,
            requests: 0,
            failures: 0,
            active: false
        };
        const provider = new BuildingProvider(stats);
        super(new TileFactory(BuildingTile), {
            name: "buildings",
            tilingScheme: webMercatorTilingScheme,
            dataProvider: provider,
            concurrentDecoderServiceName: "earth-buildings",
            concurrentDecoderScriptUrl: earthWorkerUrl("earth-decoder"),
            minDataLevel: 14,
            maxDataLevel: 14,
            minDisplayLevel: 12,
            maxDisplayLevel: 22,
            maxGeometryHeight: 9000,
            minGeometryHeight: 0,
            dataSourceOrder: 1
        });
        provider.repair = codes => {
            if (this.isDetached()) return;
            this.mapView.markTilesDirty(this, tile => codes.has(tile.tileKey.mortonCode()));
            this.requestUpdate();
        };
        this.stats = stats;
        this.buildingProvider = provider;
        this.enabled = false;
    }
    shouldSubdivide(_zoom: number, key: TileKey) {
        return key.level < 14;
    }
    canGetTile(_zoom: number, key: TileKey) {
        if (key.level !== 14 || !this.enabled) return false;
        // Bound the native tile set to a city neighborhood. Harp handles frustum
        // selection, load cancellation, cache accounting, and geometry disposal.
        const target = this.mapView.target,
            n = 2 ** 14;
        const x = ((target.longitude + 180) / 360) * n,
            y =
                ((1 -
                    Math.log(Math.tan(Math.PI / 4 + (target.latitude * Math.PI) / 360)) / Math.PI) /
                    2) *
                n;
        const dx = Math.abs(key.column + 0.5 - x),
            wrapped = Math.min(dx, n - dx);
        return wrapped <= 2 && Math.abs(key.row + 0.5 - y) <= 2;
    }
    createTileMaterial(tile: Tile, _technique: IndexedTechnique) {
        return this.style.create(tile);
    }
}
