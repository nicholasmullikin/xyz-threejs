import type { TileKey } from "@xyzmaps/harp-geoutils";
import { createBackoff } from "./imagery-backoff";

type HttpFailure = { status?: number; retryMs?: number };
const explicitLimit = (error: HttpFailure) =>
    error.status === 429 ||
    error.status === 401 ||
    error.status === 403 ||
    (error.status === 503 && error.retryMs !== undefined);

// Track fallback tiles by object identity without pinning anything evicted from harp's cache.
export class TerrainEndpoint {
    readonly held = new WeakSet<TileKey>();
    refresh?: (single: boolean) => void;
    changed?: () => void;
    private readonly gate = createBackoff(
        () => this.refresh?.(true),
        undefined,
        () => "terrain"
    );
    private disposed = false;
    private timer?: ReturnType<typeof setTimeout>;
    constructor(private readonly repeatedServerErrors = false) {}

    get paused() {
        return !this.gate.canStart("terrain");
    }
    get cooling() {
        return !!this.gate.state("terrain");
    }

    queue(single: boolean, delay = 0) {
        if (this.disposed) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh?.(single), delay);
    }

    async fetch<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (this.paused) throw Error("Terrain source is cooling down");
        const job = { key: "terrain" },
            probe = this.cooling;
        this.gate.started(job);
        try {
            const result = await request();
            this.gate.success(job);
            if (probe && !this.cooling) {
                this.changed?.();
                this.queue(false);
            }
            return result;
        } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
                this.gate.cancel(job);
                if (probe) this.queue(true);
            } else {
                const monitor =
                    probe || this.repeatedServerErrors || explicitLimit(error as HttpFailure);
                const wasCooling = this.cooling;
                const limited = monitor && this.gate.failed(job, error);
                if (limited && !wasCooling) this.changed?.();
                if (!limited && probe) {
                    // A tile-local response can show that an endpoint-wide failure ended.
                    this.gate.success(job);
                    this.queue(false);
                }
            }
            throw error;
        }
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.timer);
        this.gate.dispose();
    }
}
