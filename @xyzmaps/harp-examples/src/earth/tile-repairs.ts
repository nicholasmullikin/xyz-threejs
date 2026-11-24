// Coordinate retries by geographic tile, across replacement TileKey objects.
// The browser's online event also wakes a stationary camera after an outage.
export class TileRepairs {
    private readonly entries = new Map<number, { count: number; due: number }>();
    private timer?: ReturnType<typeof setTimeout>;
    private deadline = Infinity;
    private readonly online = () => {
        for (const entry of this.entries.values()) entry.due = 0;
        this.schedule();
    };
    constructor(private readonly repair: (codes: Set<number>) => void) {}
    connect() {
        globalThis.addEventListener?.("online", this.online);
    }
    pending(code: number) {
        return this.entries.has(code);
    }
    success(code: number) {
        this.entries.delete(code);
    }
    failed(code: number) {
        const count = (this.entries.get(code)?.count ?? 0) + 1;
        if (!this.entries.has(code) && this.entries.size >= 256)
            this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(code, {
            count,
            due: Date.now() + Math.min(1800000, 30000 * 2 ** (count - 1))
        });
        this.schedule();
    }
    private schedule() {
        if (!this.entries.size || globalThis.navigator?.onLine === false) return;
        const next = Math.min(...Array.from(this.entries.values(), entry => entry.due));
        if (!Number.isFinite(next) || (this.timer !== undefined && next >= this.deadline)) return;
        clearTimeout(this.timer);
        this.deadline = next;
        this.timer = setTimeout(
            () => {
                this.timer = undefined;
                if (globalThis.navigator?.onLine === false) return;
                const now = Date.now(),
                    codes = new Set<number>();
                for (const [code, entry] of this.entries) {
                    if (entry.due <= now) {
                        entry.due = Infinity;
                        codes.add(code);
                    }
                }
                if (codes.size) this.repair(codes);
                this.schedule();
            },
            Math.max(0, next - Date.now())
        );
    }
    dispose() {
        globalThis.removeEventListener?.("online", this.online);
        clearTimeout(this.timer);
        this.timer = undefined;
        this.entries.clear();
    }
}
