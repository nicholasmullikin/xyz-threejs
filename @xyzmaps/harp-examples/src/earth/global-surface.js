const { R } = require("./math");
const { createSurfacePreview } = require("./surface-preview");
const URLS = {
    1024: "/earth-background/surface-medium.webp",
    2048: "/earth-background/surface-2k.webp",
    4096: "/earth-background/surface.webp"
};

// Upper bound for the largest projected equirectangular texel, in drawing
// buffer pixels. A perspective projection magnifies off-axis tangents by at
// most sec(angle)^2. Only rays inside both the view and Earth's apparent
// disk contribute. The equator is the worst case for longitudinal texels.
function projectedTier(map, previous = 0) {
    const camera = map.camera,
        canvas = map.canvas;
    if (!camera?.matrixWorld || !(canvas?.height > 0 && canvas.width > 0)) return 4096;
    const p = camera.position,
        distance = p.length(),
        height = distance - R;
    if (!(height > 0) || !(camera.fov > 0)) return 4096;
    const halfAngle = Math.tan((camera.fov * Math.PI) / 360);
    const centered = (Math.PI * R * canvas.height) / (halfAngle * height);
    if (centered > 2048) return 4096;
    const m = camera.matrixWorld.elements;
    const cosCenter = Math.max(-1, Math.min(1, (p.x * m[8] + p.y * m[9] + p.z * m[10]) / distance));
    const sinRadius = R / distance;
    const cosDisk =
        cosCenter * Math.sqrt(1 - sinRadius ** 2) -
        Math.sqrt(Math.max(0, 1 - cosCenter ** 2)) * sinRadius;
    const aspect = canvas.width / canvas.height;
    const secSquared = 1 + halfAngle ** 2 * (1 + aspect ** 2);
    const required = centered * (cosDisk > 0 ? Math.min(secSquared, 1 / cosDisk ** 2) : secSquared);
    // A short resize or orbit near a tier boundary keeps its sharper image.
    if (required > 2048 || (previous === 4096 && required > 1840)) return 4096;
    if (required > 1024 || (previous >= 2048 && required > 920)) return 2048;
    return 1024;
}

function createGlobalSurface(THREE, loader, map, token, options, changed) {
    const custom = options.baseUrl && options.baseUrl !== URLS[4096];
    const streamed = !!token && !options.orbital && !options.baseUrl;
    const loaded = new Map(),
        pending = new Map(),
        failed = new Set();
    let small = createSurfacePreview(THREE),
        wanted,
        displayed = 0,
        far = false,
        upgrade,
        release,
        retryTimer,
        mayRelease = false,
        disposed = false;
    const base = { texture: small, z: -1, x: 0, y: 0, key: "earth", last: 0 };
    function display(size) {
        if (size === displayed) return;
        displayed = size;
        base.texture = loaded.get(size);
        small?.dispose();
        small = undefined;
        changed();
    }
    function reconcile() {
        if (loaded.has(wanted) && (displayed <= wanted || mayRelease)) display(wanted);
        else if (!displayed && loaded.size) display(Math.max(...loaded.keys()));
        if (!mayRelease || wanted !== displayed) return;
        for (const [size, texture] of loaded) {
            // The interactive map can return to its close-range panorama
            // instantly after an extended visit to orbit.
            if (size === displayed || (streamed && size === 1024)) continue;
            texture.dispose();
            loaded.delete(size);
        }
    }
    function retry() {
        clearTimeout(retryTimer);
        retryTimer = undefined;
        failed.clear();
        if (wanted !== undefined) request(wanted);
    }
    function request(size) {
        if (disposed || loaded.has(size) || pending.has(size) || failed.has(size)) return;
        const job = {};
        pending.set(size, job);
        job.cancel = loader.load(
            custom ? options.baseUrl : URLS[size],
            texture => {
                if (disposed) return texture.dispose();
                pending.delete(size);
                texture.wrapS = THREE.RepeatWrapping;
                texture.minFilter = THREE.LinearMipmapLinearFilter;
                texture.generateMipmaps = true;
                texture.anisotropy = Math.min(8, map.renderer.capabilities.getMaxAnisotropy());
                loaded.set(size, texture);
                reconcile();
            },
            undefined,
            () => {
                if (disposed) return;
                pending.delete(size);
                failed.add(size);
                if (!custom && !displayed && !pending.size) request(size === 1024 ? 4096 : 1024);
                if (failed.has(wanted) && retryTimer === undefined)
                    retryTimer = setTimeout(retry, 30000);
            },
            { bitmap: true }
        );
    }
    function select(size, immediate = false) {
        if (size === wanted) return;
        wanted = size;
        clearTimeout(upgrade);
        clearTimeout(release);
        mayRelease = false;
        // Avoid a large fetch for a briefly crossed altitude or viewport.
        if (!displayed && (immediate || !pending.size)) request(size);
        else if (size > displayed && !loaded.has(size))
            upgrade = setTimeout(() => request(size), 450);
        reconcile();
        release = setTimeout(() => {
            mayRelease = true;
            request(wanted);
            reconcile();
        }, 20000);
    }
    if (streamed) select(1024, true);
    else if (custom || !map.camera) select(4096, true);
    return {
        base,
        retry,
        get ready() {
            return displayed > 0;
        },
        update(zoom, localOnly = false) {
            if (disposed || custom) return;
            far = !streamed || localOnly || zoom < 6.5 ? true : zoom > 9 ? false : far;
            select(far ? projectedTier(map, wanted) : 1024);
        },
        dispose() {
            disposed = true;
            clearTimeout(upgrade);
            clearTimeout(release);
            clearTimeout(retryTimer);
            for (const job of pending.values()) job.cancel?.();
            pending.clear();
            for (const texture of loaded.values()) texture.dispose();
            loaded.clear();
            small?.dispose();
        }
    };
}
module.exports = { createGlobalSurface, projectedTier };
