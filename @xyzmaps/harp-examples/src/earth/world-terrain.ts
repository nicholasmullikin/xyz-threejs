import { TileKey } from "@xyzmaps/harp-geoutils";
import { TerrainEndpoint } from "./terrain-endpoint";
import { retryDelay } from "./imagery-backoff";
import { FetchSource, SharedPromiseCache, findTile, zxyToTileId } from "pmtiles";

// The global archive ends at zoom 12. Above it Mapterhorn publishes separate
// zoom-6 archives containing just the tiles present in regional surveys.
const REGIONAL_LEVEL = 13;
const CDN = "https://tiles.mapterhorn.com";
const ARCHIVES = "https://download.mapterhorn.com";

interface WorldRaster {
    blob: Blob;
    page: number;
}
let nextRaster = 0;

export class WorldTerrain {
    readonly stats = { indexRequests: 0, indexBytes: 0, requests: 0, bytes: 0, errors: 0 };
    readonly endpoint = new TerrainEndpoint(true);
    private readonly archives = new Map<
        number,
        { source: FetchSource; cache: SharedPromiseCache }
    >();
    private readonly readingIndex = new Set<AbortController>();
    private readonly missing = new Set<number>();
    private readonly damaged = new Set<number>();
    private readonly known = new Map<number, boolean>();
    private readonly lookups = new Map<number, Promise<boolean>>();
    private readonly tiles = new Map<number, WorldRaster | null>();
    private readonly loading = new Map<
        number,
        {
            controller: AbortController;
            users: number;
            promise: Promise<WorldRaster | undefined>;
        }
    >();
    private readonly controller = new AbortController();
    private transferMs?: number;
    constrained = false;
    private indexRetryAt = 0;
    private wakeTimer?: ReturnType<typeof setTimeout>;
    private indexTimer?: ReturnType<typeof setTimeout>;
    private cacheBytes = 0;

    constructor(private readonly changed: () => void) {}

    private notify() {
        if (this.controller.signal.aborted || this.wakeTimer !== undefined) return;
        this.wakeTimer = setTimeout(() => {
            this.wakeTimer = undefined;
            this.changed();
        }, 0);
    }

    private async indexed(key: TileKey) {
        const region = key.changedLevelBy(6 - key.level);
        const id = region.mortonCode();
        if (this.missing.has(id)) return false;
        let archive = this.archives.get(id);
        if (!archive) {
            const stats = this.stats;
            const url = `${ARCHIVES}/6-${region.column}-${region.row}.pmtiles`;
            const readers = this.readingIndex;
            const source = new (class extends FetchSource {
                async getBytes(
                    offset: number,
                    length: number,
                    signal?: AbortSignal,
                    etag?: string
                ) {
                    stats.indexRequests++;
                    const controller = new AbortController();
                    const abort = () => controller.abort();
                    signal?.addEventListener("abort", abort, { once: true });
                    readers.add(controller);
                    const timeout = setTimeout(() => controller.abort(), 5000);
                    try {
                        signal?.throwIfAborted();
                        const result = await super.getBytes(
                            offset,
                            length,
                            controller.signal,
                            etag
                        );
                        stats.indexBytes += result.data.byteLength;
                        return result;
                    } finally {
                        clearTimeout(timeout);
                        readers.delete(controller);
                        signal?.removeEventListener("abort", abort);
                    }
                }
            })(url);
            archive = { source, cache: new SharedPromiseCache(8) };
            if (this.archives.size >= 8) this.archives.delete(this.archives.keys().next().value!);
            this.archives.set(id, archive);
        }
        try {
            const header = await archive.cache.getHeader(archive.source);
            if (key.level > header.maxZoom || key.level < header.minZoom) return false;
            const tileId = zxyToTileId(key.level, key.column, key.row);
            let offset = header.rootDirectoryOffset,
                length = header.rootDirectoryLength;
            // Inspect directory entries without reading speculative WebP bodies.
            for (let depth = 0; depth < 4; depth++) {
                const dir = await archive.cache.getDirectory(
                    archive.source,
                    offset,
                    length,
                    header
                );
                const entry = findTile(dir, tileId);
                if (!entry) return false;
                if (entry.runLength > 0) return true;
                offset = header.leafDirectoryOffset + entry.offset;
                length = entry.length;
            }
            throw Error("Terrain index exceeded its maximum directory depth");
        } catch (error) {
            if (this.controller.signal.aborted) return false;
            // A rejected PMTiles directory promise is cached on the archive.
            // Drop that archive before retrying a transient network failure.
            this.archives.delete(id);
            if (error instanceof Error && error.message.endsWith(": 404")) {
                this.missing.add(id);
                return false;
            }
            this.stats.errors++;
            this.indexRetryAt = performance.now() + 30000;
            clearTimeout(this.indexTimer);
            this.indexTimer = setTimeout(() => {
                this.notify();
                this.endpoint.queue(false);
            }, 30005);
            throw error;
        }
    }

    private lookup(key: TileKey): Promise<boolean> {
        const id = key.mortonCode();
        if (this.missing.has(key.changedLevelBy(6 - key.level).mortonCode()))
            return Promise.resolve(false);
        const known = this.known.get(id);
        if (known !== undefined) return Promise.resolve(known);
        let request = this.lookups.get(id);
        if (!request) {
            if (performance.now() < this.indexRetryAt)
                return Promise.reject(Error("Terrain index cooling down"));
            request = this.indexed(key)
                .then(available => {
                    if (this.controller.signal.aborted) return false;
                    if (this.known.size >= 4096) this.known.delete(this.known.keys().next().value!);
                    this.known.set(id, available);
                    return available;
                })
                .finally(() => {
                    this.lookups.delete(id);
                    this.notify();
                });
            this.lookups.set(id, request);
        }
        return request;
    }

    canRefine(key: TileKey) {
        if (key.level < REGIONAL_LEVEL) return true;
        if (this.missing.has(key.changedLevelBy(6 - key.level).mortonCode())) return false;
        const known = this.known.get(key.mortonCode());
        if (known !== undefined) return known;
        if (this.lookups.size < 8 && performance.now() >= this.indexRetryAt)
            void this.lookup(key).catch(() => undefined);
        return false;
    }

    private async download(key: TileKey, signal: AbortSignal, repair: boolean) {
        const start = performance.now();
        const raster = await this.endpoint.fetch(async () => {
            this.stats.requests++;
            const controller = new AbortController();
            const cancel = () => controller.abort(signal.reason);
            signal.addEventListener("abort", cancel, { once: true });
            const timer = setTimeout(
                () => controller.abort(Error("Terrain transfer timed out")),
                15000
            );
            try {
                signal.throwIfAborted();
                const response = await fetch(`${CDN}/${key.level}/${key.column}/${key.row}.webp`, {
                    signal: controller.signal,
                    cache: repair ? "reload" : "default",
                    credentials: "omit",
                    referrerPolicy: "no-referrer"
                });
                if (response.status === 404) return null;
                if (!response.ok)
                    throw Object.assign(Error(`Open terrain HTTP ${response.status}`), {
                        status: response.status,
                        retryMs: retryDelay(response.headers, response.status)
                    });
                return { blob: await response.blob(), page: ++nextRaster };
            } catch (error) {
                if (!signal.aborted) this.stats.errors++;
                throw error;
            } finally {
                clearTimeout(timer);
                signal.removeEventListener("abort", cancel);
            }
        }, signal);
        signal.throwIfAborted();
        this.stats.bytes += raster?.blob.size ?? 0;
        if (raster && raster.blob.size >= 16384) {
            const ms = Math.min(5000, performance.now() - start);
            this.transferMs =
                this.transferMs === undefined ? ms : 0.75 * this.transferMs + 0.25 * ms;
            if (this.transferMs > 500) this.constrained = true;
            else if (this.transferMs < 250) this.constrained = false;
        }
        const id = key.mortonCode();
        this.tiles.set(id, raster);
        if (raster === null && key.level >= REGIONAL_LEVEL && this.known.get(id)) {
            // The CDN and its published archive can update at different times.
            this.known.set(id, false);
            this.notify();
        }
        this.cacheBytes += raster?.blob.size ?? 0;
        while (this.cacheBytes > 6 * 1024 * 1024 || this.tiles.size > 48) {
            const oldest = this.tiles.keys().next().value!;
            this.cacheBytes -= this.tiles.get(oldest)?.blob.size ?? 0;
            this.tiles.delete(oldest);
        }
        return raster ?? undefined;
    }

    rejectPage(page: number) {
        for (const [id, raster] of this.tiles) {
            if (raster?.page !== page) continue;
            this.cacheBytes -= raster.blob.size;
            this.tiles.delete(id);
            this.damaged.add(id);
            if (this.damaged.size > 48) this.damaged.delete(this.damaged.values().next().value!);
            this.stats.errors++;
            break;
        }
    }

    private async raster(key: TileKey, signal: AbortSignal | undefined, repair: boolean) {
        signal?.throwIfAborted();
        const id = key.mortonCode(),
            resident = this.tiles.get(id);
        if (resident !== undefined) {
            this.tiles.delete(id);
            this.tiles.set(id, resident);
            return resident ?? undefined;
        }
        if (this.damaged.has(id) && !repair) throw Error("Elevation page awaits repair");
        let job = this.loading.get(id);
        if (!job || job.controller.signal.aborted) {
            const controller = new AbortController();
            this.damaged.delete(id);
            job = { controller, users: 0, promise: this.download(key, controller.signal, repair) };
            this.loading.set(id, job);
        }
        job.users++;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            if (--job!.users === 0) {
                job!.controller.abort();
                if (this.loading.get(id) === job) this.loading.delete(id);
            }
        };
        // A child can leave the screen while its siblings still need the transfer.
        // Release that child's loader slot immediately and keep the shared fetch alive.
        return new Promise<WorldRaster | undefined>((resolve, reject) => {
            const cancel = () => {
                release();
                reject(signal?.reason);
            };
            signal?.addEventListener("abort", cancel, { once: true });
            job.promise.then(resolve, reject).finally(() => {
                signal?.removeEventListener("abort", cancel);
                release();
            });
        });
    }

    async read(key: TileKey, globalBase: boolean, signal?: AbortSignal, repair = false) {
        let source = key.level ? key.parent() : key;
        if (source.level < REGIONAL_LEVEL && !globalBase) return;
        let raster;
        try {
            while (source.level >= REGIONAL_LEVEL) {
                signal?.throwIfAborted();
                if (await this.lookup(source)) raster = await this.raster(source, signal, repair);
                if (raster) break;
                if (!globalBase) return;
                source = source.parent();
            }
            if (!raster) {
                signal?.throwIfAborted();
                raster = await this.raster(source, signal, repair);
            }
            this.endpoint.held.delete(key);
        } catch (error) {
            if (
                !signal?.aborted &&
                (this.endpoint.cooling || performance.now() < this.indexRetryAt)
            )
                this.endpoint.held.add(key);
            throw error;
        }
        if (!raster) return;
        // A provisional child may already be in the loader when a regional
        // directory reports no coverage. Crop the real next available survey
        // or global tile instead of freezing the first coarse resident mesh.
        const scale = 2 ** (key.level - source.level);
        const size = 512 / scale;
        return {
            kind: "terrarium-webp",
            sourceLevel: source.level + 1,
            // A Blob shares immutable compressed bytes with decoder workers. The page
            // ID changes on a fresh download, even at the same source coordinates.
            raster: raster.blob,
            page: raster.page,
            x: (key.column - source.column * scale) * size,
            y: (key.row - source.row * scale) * size,
            size
        };
    }

    dispose() {
        this.controller.abort();
        clearTimeout(this.wakeTimer);
        clearTimeout(this.indexTimer);
        this.endpoint.dispose();
        for (const controller of this.readingIndex) controller.abort();
        for (const job of this.loading.values()) job.controller.abort();
        this.cacheBytes = 0;
        this.loading.clear();
        this.lookups.clear();
        this.known.clear();
        this.tiles.clear();
        this.archives.clear();
        this.missing.clear();
        this.damaged.clear();
    }
}
