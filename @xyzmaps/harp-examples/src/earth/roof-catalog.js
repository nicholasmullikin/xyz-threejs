// Each sparse z12 record holds roof attributes for four-by-four building tiles.
// One archive directory and a bounded set of records serve nearby camera moves.
const { PMTiles, SharedPromiseCache } = require("pmtiles");
function createRoofCatalog(repair) {
    const controller = new AbortController(),
        records = new Map();
    const root = new URL("/earth-data/mapped-buildings/", location.href);
    const directoryCache = new SharedPromiseCache(24),
        archives = new Map();
    let index;
    async function archiveFor(x, y) {
        index ??= fetch(new URL("index.json", root), { signal: controller.signal })
            .then(async response => {
                if (!response.ok) throw Error("Roof catalog unavailable");
                const data = await response.json();
                if (data.format !== "ERF4" || !Array.isArray(data.regions))
                    throw Error("Unexpected roof catalog");
                return new Set(data.regions);
            })
            .catch(error => {
                index = undefined;
                throw error;
            });
        const name = (x >> 8) + "-" + (y >> 8) + ".pmtiles";
        if (!(await index).has(name) || disposed) return;
        let archive = archives.get(name);
        if (!archive) {
            archive = new PMTiles(new URL(name, root).href, directoryCache);
            archives.set(name, archive);
            if (archives.size > 6) archives.delete(archives.keys().next().value);
        }
        return archive;
    }
    let retryAfter = 0,
        disposed = false;
    function get(key) {
        if (disposed || performance.now() < retryAfter) return;
        const x = key.column >> 2,
            y = key.row >> 2,
            id = x + 4096 * y;
        let rec = records.get(id);
        if (rec) {
            records.delete(id);
            records.set(id, rec);
            return rec;
        }
        rec = { done: false, data: undefined, waiting: new Set() };
        records.set(id, rec);
        rec.promise = archiveFor(x, y)
            .then(archive => archive?.getZxy(12, x, y, controller.signal))
            .then(result => {
                if (disposed) return;
                if (result?.data?.byteLength >= 4 && result.data.byteLength <= 2e6)
                    rec.data = result.data;
                if (rec.data && rec.waiting.size) repair(rec.waiting);
            })
            .catch(() => {
                records.delete(id);
                retryAfter = performance.now() + 30000;
            })
            .finally(() => {
                rec.done = true;
                rec.waiting.clear();
                for (const [k, v] of records) {
                    if (records.size <= 16) break;
                    if (v.done) records.delete(k);
                }
            });
        return rec;
    }
    return {
        get,
        dispose() {
            disposed = true;
            controller.abort();
            records.clear();
            archives.clear();
        }
    };
}
module.exports = { createRoofCatalog };
