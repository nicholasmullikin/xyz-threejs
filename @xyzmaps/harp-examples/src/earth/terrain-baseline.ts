import { TileKey } from "@xyzmaps/harp-geoutils";

export type ReliefPayload = {
    kind: "bundled-relief";
    page: string;
    raster: Blob;
    x: number;
    y: number;
    scale: number;
    size: number;
};

// Fetched only after the remote terrain sources and sufficiently detailed
// cached ancestors are unavailable. A camera usually needs a single region.
export class TerrainBaseline {
    private readonly controller = new AbortController();
    private coverage?: Promise<string[]>;
    private readonly pages = new Map<string, Promise<Blob>>();
    private readonly failed = new Map<string, number>();
    readonly stats = { pages: 0, bytes: 0, tiles: 0 };

    private failedFile(name: string) {
        if (this.controller.signal.aborted) return;
        this.failed.set(name, performance.now() + 30000);
        if (this.failed.size > 24) this.failed.delete(this.failed.keys().next().value!);
    }

    async rejectPage({ page, raster }: ReliefPayload) {
        const cached = this.pages.get(page);
        if (cached && (await cached.catch(() => undefined)) === raster && this.pages.get(page) === cached) {
            this.pages.delete(page);
            this.failedFile(page + ".webp");
        }
    }

    private async readFile<T>(name: string, repair: boolean, read: (response: Response) => Promise<T>) {
        const retryAt = this.failed.get(name);
        if (!repair && retryAt !== undefined && performance.now() < retryAt)
            throw Error("Bundled elevation awaits repair");
        try {
            const response = await fetch("resources/earth/terrain-base-v1/" + name, {
                signal: this.controller.signal,
                cache: retryAt === undefined ? "default" : "reload"
            });
            if (!response.ok) throw Error("Bundled elevation unavailable");
            const data = await read(response);
            this.failed.delete(name);
            return data;
        } catch (error) {
            this.failedFile(name);
            throw error;
        }
    }

    async read(key: TileKey, signal?: AbortSignal, repair = false): Promise<ReliefPayload | undefined> {
        signal?.throwIfAborted();
        this.coverage ??= this.readFile("coverage.json", repair, async response => {
            const levels: unknown = await response.json();
            if (!Array.isArray(levels) || levels.length !== 5 || !levels.every((bits, z) =>
                typeof bits === "string" && bits.length === 2 * Math.ceil(4 ** z / 8) && /^[a-f0-9]+$/i.test(bits)
            )) throw Error("Invalid bundled elevation coverage");
            return levels as string[];
        }).catch(error => {
            this.coverage = undefined;
            throw error;
        });
        const coverage = await this.coverage;
        signal?.throwIfAborted();
        const level = Math.min(4, key.level);
        const scale = 2 ** (key.level - level);
        const x = Math.floor(key.column / scale), y = Math.floor(key.row / scale);
        const index = y * 2 ** level + x, offset = (index >>> 3) * 2;
        const byte = parseInt(coverage[level].slice(offset, offset + 2), 16);
        if (!(byte & (1 << (index & 7)))) return;
        const page = level + "-" + x + "-" + y;
        let loading = this.pages.get(page);
        if (!loading) {
            loading = this.readFile(page + ".webp", repair, async response => {
                const blob = await response.blob();
                const header = new DataView(await blob.slice(0, 12).arrayBuffer());
                if (header.byteLength < 12 || header.getUint32(0) !== 0x52494646 || header.getUint32(8) !== 0x57454250)
                    throw Error("Invalid bundled elevation page");
                this.stats.pages++;
                this.stats.bytes += blob.size;
                return blob;
            });
            const requested = loading;
            loading.catch(() => {
                if (this.pages.get(page) === requested) this.pages.delete(page);
            });
        }
        this.pages.delete(page);
        this.pages.set(page, loading);
        if (this.pages.size > 24) this.pages.delete(this.pages.keys().next().value!);
        const raster = await loading;
        signal?.throwIfAborted();
        this.stats.tiles++;
        return {
            kind: "bundled-relief", page, raster,
            x: key.column % scale, y: key.row % scale,
            scale, size: level === 4 ? 1024 : 128
        };
    }

    dispose() {
        this.controller.abort();
        this.pages.clear();
        this.failed.clear();
    }
}
