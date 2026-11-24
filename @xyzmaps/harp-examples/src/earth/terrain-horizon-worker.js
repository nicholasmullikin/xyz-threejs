const { TerrainBaseline } = require("./terrain-baseline");
const { baselinePage } = require("../../decoder/baseline-heights");
const { horizonField } = require("./terrain-horizon");
const source = new TerrainBaseline();
self.onmessage = async ({ data: region }) => {
    try {
        // The receiver region plus the rays towards the sun normally intersect
        // one ETOPO page, or up to four near a boundary or the date line.
        const pages = new Map(),
            jobs = [];
        const x0 = Math.floor(16 * (region.x - region.span + Math.min(0, region.dx * 37000)));
        const x1 = Math.floor(16 * (region.x + region.span + Math.max(0, region.dx * 37000)));
        const y0 = Math.max(
            0,
            Math.floor(16 * (region.y - region.span + Math.min(0, region.dy * 37000)))
        );
        const y1 = Math.min(
            15,
            Math.floor(16 * (region.y + region.span + Math.max(0, region.dy * 37000)))
        );
        for (let y = y0; y <= y1; y++)
            for (let i = x0; i <= x1; i++) {
                const x = ((i % 16) + 16) % 16;
                jobs.push(
                    source.read({ level: 4, column: x, row: y }).then(async page => {
                        if (page) pages.set(y * 16 + x, await baselinePage(page));
                    })
                );
            }
        await Promise.all(jobs);
        const heights = horizonField(region, (mx, my) => {
            const x = 16 * (mx - Math.floor(mx)),
                y = Math.max(0, Math.min(15.999999999, my * 16));
            const px = Math.floor(x),
                py = Math.floor(y),
                page = pages.get(py * 16 + px);
            if (!page) return 0;
            const sx = (x - px) * 1024 + 0.5,
                sy = (y - py) * 1024 + 0.5;
            const ix = Math.floor(sx),
                iy = Math.floor(sy),
                fx = sx - ix,
                fy = sy - iy;
            const k = iy * 1026 + ix;
            return (
                (page[k] * (1 - fx) + page[k + 1] * fx) * (1 - fy) +
                (page[k + 1026] * (1 - fx) + page[k + 1027] * fx) * fy
            );
        });
        self.postMessage({ region, heights, bytes: source.stats.bytes }, [heights.buffer]);
    } catch {
        self.postMessage({ unavailable: true });
    }
};
