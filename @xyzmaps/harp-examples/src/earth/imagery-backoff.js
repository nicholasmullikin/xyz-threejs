// An endpoint-wide limit applies to every visible raster tile. A single
// request checks recovery before restoring ordinary parallel scheduling.
function retryDelay(headers, status, wallTime = Date.now()) {
    const retry = headers.get("Retry-After");
    if (retry !== null) {
        const ms = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - wallTime;
        if (Number.isFinite(ms)) return Math.max(0, ms);
    }
    if (status === 429) {
        const reset = headers.get("X-Rate-Limit-Reset");
        if (reset !== null && /^\d+$/.test(reset))
            return Math.max(0, Number(reset) * 1000 - wallTime);
    }
}

/** @type {(key: string) => string} */
const imagerySource = key => (key.startsWith("c:") ? "street" : "satellite");
function createBackoff(wake, clock = () => performance.now(), source = imagerySource) {
    const holds = new Map(),
        recent = new Map();
    let timer;
    function schedule() {
        clearTimeout(timer);
        const now = clock();
        let next = Infinity;
        for (const h of holds.values()) if (h.until > now) next = Math.min(next, h.until);
        if (next < Infinity)
            timer = setTimeout(
                () => {
                    schedule();
                    wake();
                },
                Math.min(2147483647, next - now + 5)
            );
    }
    return {
        state(key) {
            return holds.get(source(key));
        },
        canStart(key) {
            const h = holds.get(source(key));
            return !h || (clock() >= h.until && !h.probe);
        },
        started(job) {
            const h = holds.get(source(job.key));
            if (h) h.probe = job;
        },
        cancel(job) {
            const h = holds.get(source(job.key));
            if (h?.probe === job) h.probe = undefined;
        },
        success(job) {
            const id = source(job.key);
            recent.delete(id);
            if (holds.get(id)?.probe === job) {
                holds.delete(id);
                schedule();
            }
        },
        failed(job, error) {
            const id = source(job.key),
                now = clock(),
                h = holds.get(id);
            const status = error?.status;
            const auth = status === 401 || status === 403;
            const server =
                (!status || status >= 500) &&
                (error?.codecExhausted || !/decod/i.test(error?.message || ""));
            if (!auth && status !== 429 && status !== 503 && !server) return false;
            if (!auth && status !== 429 && status !== 503 && !h) {
                const times = (recent.get(id) || []).filter(t => now - t < 2000);
                times.push(now);
                recent.set(id, times);
                if (times.length < 3) return false;
            }
            const attempt = h ? Math.min(5, h.attempt + (h.probe === job ? 1 : 0)) : 0;
            const reason = auth ? "authentication" : status === 429 ? "throttled" : "unavailable";
            // A response still on the wire must not end or shorten an active
            // credential refusal/rate limit for this source.
            if (h && h.until > now && h.reason === "authentication" && !auth) return true;
            const delay = auth
                ? 300000
                : Math.max(250, error.retryMs ?? Math.min(60000, 2000 * 2 ** attempt));
            holds.set(id, { reason, attempt, until: Math.max(h?.until || 0, now + delay) });
            schedule();
            return true;
        },
        dispose() {
            clearTimeout(timer);
            holds.clear();
            recent.clear();
        }
    };
}
module.exports = { retryDelay, createBackoff };
