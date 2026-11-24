// Keep a bounded set of original embedded photographs. A tile first seen in
// the distance can recover its source texels when the camera approaches.
function surveyTextures(small, tiles, stats, wake) {
    const MIB = 1024 * 1024,
        sourceLimit = (small ? 6 : 18) * MIB,
        extraLimit = (small ? 5 : 18) * MIB;
    const blobs = new Map(),
        upgrades = new Map();
    let sourceBytes = 0,
        extraBytes = 0,
        busy = false,
        disposed = false,
        baseBytes = 0;
    const memory = (w, h, tex) => Math.ceil(w * h * 4 * (tex.generateMipmaps ? 4 / 3 : 1));
    function report() {
        stats.photoSourceBytes = sourceBytes;
        stats.photoExtraBytes = extraBytes;
        stats.photoBackupBytes = baseBytes;
    }
    function forget(tex) {
        const record = blobs.get(tex);
        if (!record) return;
        sourceBytes -= record.blob.size;
        blobs.delete(tex);
        report();
    }
    function release(event) {
        const tex = event.target;
        tex.removeEventListener("dispose", release);
        forget(tex);
        const previous = upgrades.get(tex);
        if (previous) {
            extraBytes -= previous.extra;
            baseBytes -= previous.backupBytes;
            previous.base.close?.();
            upgrades.delete(tex);
        }
        report();
    }
    function register(parser) {
        return {
            name: "EARTH_survey_embedded_images",
            async afterRoot(result) {
                const pending = [],
                    textures = new Set();
                result.scene.traverse(o => {
                    if (o.material)
                        for (const mat of [].concat(o.material)) if (mat.map) textures.add(mat.map);
                });
                for (const tex of textures) {
                    const id = parser.associations.get(tex)?.textures,
                        def = parser.json.textures?.[id];
                    const image = parser.json.images?.[def?.source],
                        src = tex.image;
                    if (
                        !image ||
                        !Number.isInteger(image.bufferView) ||
                        !src ||
                        Math.max(src.width, src.height) <= 256
                    )
                        continue;
                    pending.push(
                        parser.getDependency("bufferView", image.bufferView).then(buffer => {
                            if (disposed || buffer.byteLength > sourceLimit / 2) return;
                            while (blobs.size && sourceBytes + buffer.byteLength > sourceLimit)
                                forget(blobs.keys().next().value);
                            const blob = new Blob([buffer], { type: image.mimeType });
                            blobs.set(tex, { blob, w: src.width, h: src.height });
                            sourceBytes += blob.size;
                            tex.addEventListener("dispose", release);
                            report();
                        })
                    );
                }
                await Promise.all(pending);
            }
        };
    }
    function replaceImage(tex, image) {
        // WebGL2 uses immutable storage, so growing texSubImage2D would fail.
        tex.removeEventListener("dispose", release);
        tex.dispose();
        tex.source = new tex.source.constructor(image);
        tex.addEventListener("dispose", release);
        tex.needsUpdate = true;
    }
    function reduce(tex, state) {
        const image = tex.image;
        replaceImage(tex, state.base);
        image.close?.();
        extraBytes -= state.extra;
        baseBytes -= state.backupBytes;
        state.tile.cached.bytesUsed -= state.extra;
        tiles.lruCache.updateMemoryUsage(state.tile);
        upgrades.delete(tex);
        report();
    }
    function update() {
        const now = performance.now();
        if (disposed || busy || !blobs.size || now < tiles.deferUntil) return;
        // Release enhancements belonging to hidden replacement parents before
        // admitting new close-up textures. The cheap base remains drawable.
        for (const [tex, state] of upgrades) {
            if (tiles.visibleTiles.has(state.tile)) state.lastVisible = now;
            else if (now - state.lastVisible > 550) reduce(tex, state);
        }
        const info = tiles.cameraInfo[0],
            axis = tiles.cameras[0].matrixWorld.elements;
        let best;
        for (const tile of tiles.visibleTiles) {
            if (tile.children?.length && tile.__error > tiles.errorTarget * 1.6) continue;
            const maps = tile.cached.textures,
                sphere = tile.cached.photoBounds;
            if (!maps?.length || !sphere) continue;
            const dx = sphere.center.x - info.position.x,
                dy = sphere.center.y - info.position.y,
                dz = sphere.center.z - info.position.z;
            const distance = Math.max(10, Math.hypot(dx, dy, dz));
            const depth = -(axis[8] * dx + axis[9] * dy + axis[10] * dz);
            const offAxis = Math.max(
                0,
                Math.sqrt(Math.max(0, distance * distance - depth * depth)) - sphere.radius
            );
            const target = Math.min(
                small ? 768 : 1536,
                (2 * sphere.radius) / (distance * info.sseDenominator)
            );
            for (const tex of maps) {
                const record = blobs.get(tex),
                    old = tex.image;
                if (!record || !old) continue;
                const current = Math.max(old.width, old.height),
                    original = Math.max(record.w, record.h);
                const wanted = Math.min(original, 2 ** Math.ceil(Math.log2(Math.max(1, target))));
                if (wanted < current * 1.75) continue;
                // Stream a single mip at a time. One oversized tile must not
                // prevent adjacent visible textures from making any progress.
                const scale = Math.min(wanted, current * 2) / original,
                    w = Math.max(1, Math.round(record.w * scale)),
                    h = Math.max(1, Math.round(record.h * scale));
                const extra = memory(w, h, tex) - memory(old.width, old.height, tex);
                if (
                    extraBytes + extra > extraLimit ||
                    tiles.lruCache.cachedBytes + extra > tiles.lruCache.maxBytesSize
                )
                    continue;
                const score = Math.min(target, original) / current / (1 + (4 * offAxis) / distance);
                if (!best || score > best.score)
                    best = { tex, record, tile, old, w, h, extra, score };
            }
        }
        if (!best) return;
        const { tex, record, tile, old, w, h, extra } = best;
        busy = true;
        createImageBitmap(record.blob, {
            resizeWidth: w,
            resizeHeight: h,
            resizeQuality: "high",
            colorSpaceConversion: "none",
            premultiplyAlpha: "none"
        })
            .then(image => {
                if (
                    disposed ||
                    !tiles.visibleTiles.has(tile) ||
                    blobs.get(tex) !== record ||
                    tex.image !== old
                ) {
                    image.close();
                    return;
                }
                replaceImage(tex, image);
                let state = upgrades.get(tex);
                if (!state) {
                    state = { tile, base: old, backupBytes: old.width * old.height * 4, extra: 0 };
                    baseBytes += state.backupBytes;
                    upgrades.set(tex, state);
                } else old.close?.();
                extraBytes += extra;
                state.extra += extra;
                state.lastVisible = performance.now();
                tile.cached.bytesUsed += extra;
                tiles.lruCache.updateMemoryUsage(tile);
                stats.photoPromotions = (stats.photoPromotions || 0) + 1;
                report();
            })
            .catch(() => forget(tex))
            .finally(() => {
                busy = false;
                if (!disposed) wake();
            });
    }
    function dispose() {
        disposed = true;
        for (const tex of new Set([...blobs.keys(), ...upgrades.keys()]))
            tex.removeEventListener("dispose", release);
        for (const state of upgrades.values()) state.base.close?.();
        blobs.clear();
        upgrades.clear();
        sourceBytes = extraBytes = baseBytes = 0;
        report();
    }
    return { register, update, dispose };
}
module.exports = { surveyTextures };
