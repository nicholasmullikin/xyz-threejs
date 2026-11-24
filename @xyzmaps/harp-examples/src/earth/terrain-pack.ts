import { TileKey } from "@xyzmaps/harp-geoutils";
import { TileRepairs } from "./tile-repairs";

export const DETAIL_BASE = 15;
const REGION_LEVEL = 8;
type Row = [number, number, number, number, number];

export class TerrainPack {
    readonly stats = { indexedRegions: 0, loadedRegions: 0, requests: 0, bytes: 0, errors: 0 };
    edgeDistancePixels = 0;
    private readonly regions = new Set<number>();
    private readonly shards = new Map<number, Map<number, Row>>();
    private readonly active = new Map<number, AbortController>();
    private readonly failed = new Set<number>();
    private disposed = false;
    private readonly repairs = new TileRepairs(codes => {
        for (const code of codes) this.failed.delete(code);
        if (codes.has(-1)) this.load(-1);
        this.changed();
    });

    constructor(
        private readonly url: URL,
        private readonly changed: () => void
    ) {}

    connect() {
        this.repairs.connect();
        this.load(-1);
    }

    private load(code: number) {
        if (
            this.disposed ||
            this.active.has(code) ||
            this.failed.has(code) ||
            this.active.size >= 2
        )
            return;
        const controller = new AbortController();
        this.active.set(code, controller);
        const url =
            code === -1
                ? this.url
                : new URL(`regions/${code % 256}/${Math.floor(code / 256)}.json`, this.url);
        void (async () => {
            try {
                const response = await fetch(url, {
                    signal: controller.signal,
                    credentials: "omit",
                    referrerPolicy: "no-referrer"
                });
                if (!response.ok) throw Error(`Terrain pack index HTTP ${response.status}`);
                const data = await response.json();
                if (this.disposed) return;
                if (code === -1) {
                    if (data.format !== "harp-3dep-v1" || !Array.isArray(data.regions))
                        throw Error("Invalid terrain pack manifest");
                    for (const key of data.regions) {
                        const parts =
                            typeof key === "string" && key.match(/^(\d{1,3})\/(\d{1,3})$/);
                        if (!parts || +parts[1] > 255 || +parts[2] > 255)
                            throw Error("Invalid terrain pack region");
                    }
                    const edge = data.edgeDistancePixels ?? 0;
                    if (!Number.isFinite(edge) || edge < 0 || edge > 1024)
                        throw Error("Invalid terrain coverage distance");
                    this.edgeDistancePixels = edge;
                    for (const key of data.regions) {
                        const [x, y] = key.split("/").map(Number);
                        this.regions.add(y * 256 + x);
                    }
                    this.stats.indexedRegions = this.regions.size;
                } else {
                    if (!Array.isArray(data) || data.length > 16384)
                        throw Error("Invalid terrain availability index");
                    const rows = new Map<number, Row>();
                    for (const row of data) {
                        if (
                            !Array.isArray(row) ||
                            row.length !== 5 ||
                            !row.every(Number.isInteger) ||
                            row[0] < 0 ||
                            row[0] >= 16384 ||
                            row[1] < 0 ||
                            row[1] > 15 ||
                            row[2] < 0 ||
                            row[2] > 15 ||
                            row[4] < 0 ||
                            row[4] > 65535 ||
                            row[3] < 0 ||
                            row[3] > 65535 ||
                            row[2] & ~row[1] ||
                            row[4] & ~row[3]
                        )
                            throw Error("Invalid terrain availability row");
                        rows.set(row[0], row as Row);
                    }
                    if (this.shards.size >= 24)
                        this.shards.delete(this.shards.keys().next().value!);
                    this.shards.set(code, rows);
                    this.stats.loadedRegions = this.shards.size;
                }
                this.repairs.success(code);
            } catch {
                if (controller.signal.aborted) return;
                this.stats.errors++;
                this.failed.add(code);
                this.repairs.failed(code);
            } finally {
                this.active.delete(code);
                if (!this.disposed) this.changed();
            }
        })();
    }

    private coverage(key: TileKey) {
        const root = key.changedLevelBy(DETAIL_BASE - key.level);
        const block = 2 ** (DETAIL_BASE - REGION_LEVEL);
        const region = Math.floor(root.row / block) * 256 + Math.floor(root.column / block);
        if (!this.regions.has(region)) return;
        const shard = this.shards.get(region);
        if (!shard) {
            this.load(region);
            return;
        }
        return shard.get((root.row % block) * block + (root.column % block));
    }

    canRefine(key: TileKey) {
        const row = this.coverage(key);
        if (!row) return false;
        if (key.level === DETAIL_BASE) return row[1] !== 0;
        if (key.level !== 16) return false;
        const start = 8 * (key.row % 2) + 2 * (key.column % 2);
        return (row[3] & (0x33 << start)) !== 0;
    }

    // 0 = virtual crop of the base; 1 = surveyed; 2 = surveyed with a validity/edge mask.
    availability(key: TileKey) {
        const row = this.coverage(key);
        if (!row || key.level < 16 || key.level > 17) return 0;
        const side = 2 ** (key.level - DETAIL_BASE);
        const bit = 1 << ((key.row % side) * side + (key.column % side));
        const field = key.level === 16 ? 1 : 3;
        return !(row[field] & bit) ? 0 : row[field + 1] & bit ? 2 : 1;
    }

    async read(key: TileKey, signal?: AbortSignal, repair = false) {
        const url = new URL(`tiles/${key.level}/${key.column}/${key.row}.png`, this.url);
        this.stats.requests++;
        const response = await fetch(url, {
            signal,
            cache: repair ? "reload" : "default",
            credentials: "omit",
            referrerPolicy: "no-referrer"
        });
        if (!response.ok) throw Error(`Terrain detail HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        if (!bytes.byteLength) throw Error("Empty terrain detail raster");
        this.stats.bytes += bytes.byteLength;
        return bytes;
    }

    dispose() {
        this.disposed = true;
        this.repairs.dispose();
        for (const controller of this.active.values()) controller.abort();
        this.active.clear();
        this.shards.clear();
        this.regions.clear();
        this.failed.clear();
    }
}
