// Continuous photomeshes can refine different sibling tiles on different
// frames. Render a small set of resident ancestors only in uncovered pixels.
function photoFallback(THREE, tiles) {
    const active = [];
    const sphere = new THREE.Sphere(),
        east = new THREE.Vector3(),
        north = new THREE.Vector3();
    const probes = Array.from({ length: 5 }, () => new THREE.Vector3());
    function role(tile, index) {
        const scene = tile.cached.scene;
        if (!scene) return;
        const order = index < 0 ? -10 : -9 + index * 0.01;
        scene.traverse(o => {
            o.renderOrder = order;
            if (!o.isMesh) return;
            for (const m of [].concat(o.material)) {
                m.stencilFunc = index < 0 ? THREE.AlwaysStencilFunc : THREE.NotEqualStencilFunc;
                m.stencilFuncMask = index < 0 ? 255 : 64;
            }
        });
        if (index < 0) tiles.group.remove(scene);
        else tiles.group.add(scene);
    }
    function clear() {
        for (const t of active) role(t, -1);
        active.length = 0;
    }
    function update(distance, camera) {
        const width = Math.max(90, distance * 0.7),
            target = tiles.focus;
        east.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
        north.crossVectors(target, east).normalize();
        const offsets = [
            [0, 0],
            [-1, 0],
            [1, 0],
            [0, 1.5],
            [0, -0.8]
        ];
        offsets.forEach(([x, y], i) =>
            probes[i]
                .copy(target)
                .addScaledVector(east, x * width)
                .addScaledVector(north, y * width)
        );
        const best = Array(6).fill(Infinity),
            selected = Array(6);
        for (const t of tiles.lruCache.itemList) {
            if (
                !t.cached?.scene ||
                !t.cached.hasPhoto ||
                !t.children?.length ||
                tiles.visibleTiles.has(t)
            )
                continue;
            const bounds = t.cached.boundingVolume;
            bounds.getSphere(sphere);
            // Small leaves can cover only a sliver of the viewport. Keep one
            // broader level available for a fast reversal or an incomplete child.
            if (sphere.radius < width * 0.35 || sphere.radius > width * 45) continue;
            for (let i = 0; i < 6; i++) {
                const d = bounds.distanceToPoint(probes[i === 5 ? 0 : i]);
                if (d > width * 0.95) continue;
                const desired = width * (i === 5 ? 9 : 2.5);
                const score = (4 * d) / width + Math.abs(Math.log2(sphere.radius / desired));
                if (score < best[i]) {
                    best[i] = score;
                    selected[i] = t;
                }
            }
        }
        // Give the center and its broad ancestor first claim. Of the four
        // edge probes, prefer the model serving the most missing directions.
        // Three extra draw groups cap close-range vertex work on integrated GPUs.
        const votes = new Map();
        for (const t of selected.slice(1, 5)) if (t) votes.set(t, (votes.get(t) || 0) + 1);
        const ranked = [...votes.keys()].sort(
            (a, b) => votes.get(b) - votes.get(a) || a.geometricError - b.geometricError
        );
        const distinct = [...new Set([selected[0], selected[5], ...ranked].filter(Boolean))].slice(
            0,
            3
        );
        distinct.sort((a, b) => a.geometricError - b.geometricError);
        for (const t of distinct) {
            role(t, active.length);
            tiles.lruCache.markUsed(t);
            active.push(t);
        }
        return active.length;
    }
    return { clear, update };
}
module.exports = { photoFallback };
