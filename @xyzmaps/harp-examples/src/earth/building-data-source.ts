import { DataProvider, TileDataSource, TileFactory } from "@xyzmaps/harp-mapview-decoder";
import { Tile } from "@xyzmaps/harp-mapview";
import { IndexedTechnique } from "@xyzmaps/harp-datasource-protocol";
import { TileKey, webMercatorTilingScheme } from "@xyzmaps/harp-geoutils";
import * as THREE from "three";
export interface BuildingStats {
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
    private template = "";
    private disposed = false;
    private controllers = new Set<AbortController>();
    private waiters: Array<() => void> = [];
    constructor(private stats: BuildingStats) {
        super();
    }
    ready() {
        return !!this.template;
    }
    protected async connect() {
        const controller = new AbortController();
        this.controllers.add(controller);
        try {
            const response = await fetch("https://tiles.openfreemap.org/planet", {
                signal: controller.signal
            });
            if (!response.ok) throw Error(`Building metadata HTTP ${response.status}`);
            const metadata = await response.json();
            if (this.disposed) throw new DOMException("Cancelled", "AbortError");
            this.template = metadata.tiles[0];
        } finally {
            this.controllers.delete(controller);
        }
    }

    protected dispose() {
        this.disposed = true;
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
        try {
            const url = this.template
                .replace("{z}", String(key.level))
                .replace("{x}", String(key.column))
                .replace("{y}", String(key.row));
            for (let attempt = 0; ; attempt++) {
                this.stats.requests++;
                try {
                    const response = await fetch(url, { signal: controller.signal });
                    if (!response.ok) throw Error(`Building tile HTTP ${response.status}`);
                    return await response.arrayBuffer();
                } catch (error) {
                    if (controller.signal.aborted) throw error;
                    this.stats.failures++;
                    if (attempt >= 2) throw error;
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
export class BuildingsDataSource extends TileDataSource {
    readonly stats: BuildingStats;
    constructor(private style: BuildingStyle) {
        const stats: BuildingStats = {
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
        super(new TileFactory(Tile), {
            name: "buildings",
            tilingScheme: webMercatorTilingScheme,
            dataProvider: new BuildingProvider(stats),
            concurrentDecoderServiceName: "earth-buildings",
            concurrentDecoderScriptUrl: "decoder.bundle.js",
            minDataLevel: 14,
            maxDataLevel: 14,
            minDisplayLevel: 12,
            maxDisplayLevel: 22,
            maxGeometryHeight: 9000,
            minGeometryHeight: 0,
            dataSourceOrder: 1
        });
        this.stats = stats;
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
