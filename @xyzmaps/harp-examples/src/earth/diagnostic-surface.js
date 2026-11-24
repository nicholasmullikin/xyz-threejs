// Sample the same triangulation and shader displacement as picking. Use a fixed
// geographic patch so a moving camera cannot masquerade as a changing surface.
const { terrainTopology, samplePosition } = require("./terrain-sample");
const { gridWidth } = require("./terrain-grid");
const side = 17;
function coordinates(item) {
    const k = item.tileKey || item;
    return { z: k.level ?? k.z, x: k.column ?? k.x, y: k.row ?? k.y };
}
function contains(item, x, y) {
    const k = coordinates(item),
        n = 2 ** k.z;
    return Math.floor(x * n) === k.x && Math.floor(y * n) === k.y;
}
function sourceLevel(tile) {
    return (
        tile.objects[0]?.geometry.userData.attributeMetadata?.position?.terrainSourceLevel ??
        tile.objects[0]?.userData.terrainCropLevel ??
        tile.tileKey.level
    );
}
function indexTiles(tiles, bySource = false) {
    const sorted = [...tiles].filter(t => !t.disposed && t.objects[0]?.geometry?.attributes.uv);
    sorted.sort(
        (a, b) => (bySource && sourceLevel(b) - sourceLevel(a)) || b.tileKey.level - a.tileKey.level
    );
    return sorted;
}
function samplePatch(THREE, key, sorted, native = false) {
    const records = new Map(),
        out = new Float64Array(side * side * 3);
    out.fill(NaN);
    const temp = new THREE.Vector3(),
        n = 2 ** key.z;
    for (let j = 0; j < side; j++)
        for (let i = 0; i < side; i++) {
            const x = (key.x + Math.min(1 - 1e-8, i / (side - 1))) / n;
            const y = (key.y + Math.min(1 - 1e-8, j / (side - 1))) / n;
            const tile = sorted.find(t => contains(t, x, y));
            if (!tile) continue;
            let record = records.get(tile);
            if (!record) {
                const g = tile.objects[0].geometry;
                record = {
                    positions: g.attributes.position.array,
                    width: gridWidth(g),
                    topology: terrainTopology(g),
                    diagonal: g.userData.attributeMetadata?.position?.terrainDiagonal,
                    matrix: tile.boundingBox.getRotationMatrix().setPosition(tile.center),
                    morph: native ? undefined : g.userData.terrainTransition
                };
                records.set(tile, record);
            }
            const k = tile.tileKey,
                scale = 2 ** k.level;
            samplePosition(record, x * scale - k.column, y * scale - k.row, temp);
            temp.applyMatrix4(record.matrix).toArray(out, (j * side + i) * 3);
        }
    return out;
}
function projectPatch(THREE, map, grid) {
    const p = new THREE.Vector3(),
        w = map.canvas.width,
        h = map.canvas.height;
    const screen = [];
    for (let i = 0; i < grid.length; i += 3) {
        p.fromArray(grid, i).project(map.camera);
        screen.push(
            Number.isFinite(p.x) && p.z >= -1 && p.z <= 1
                ? [((1 + p.x) * w) / 2, ((1 - p.y) * h) / 2]
                : null
        );
    }
    return screen;
}
function outline(screen, w, h) {
    const envelope = new Float64Array(256).fill(Infinity);
    function edge(a, b) {
        if (!a || !b) return;
        if (b[0] < a[0]) [a, b] = [b, a];
        const scale = w / envelope.length;
        for (
            let i = Math.max(0, Math.ceil(a[0] / scale - 0.5));
            i <= Math.min(255, Math.floor(b[0] / scale - 0.5));
            i++
        ) {
            const y =
                a[1] + ((b[1] - a[1]) * ((i + 0.5) * scale - a[0])) / Math.max(1e-9, b[0] - a[0]);
            if (y >= 0 && y < h) envelope[i] = Math.min(envelope[i], y);
        }
    }
    for (let j = 0; j < side; j++)
        for (let i = 0; i < side; i++) {
            const k = j * side + i;
            if (i) edge(screen[k - 1], screen[k]);
            if (j) edge(screen[k - side], screen[k]);
        }
    return envelope;
}
function difference(a, b) {
    let max = null;
    for (let i = 0; i < a.length; i++)
        if (Number.isFinite(a[i]) && Number.isFinite(b[i]))
            max = Math.max(max ?? 0, Math.abs(a[i] - b[i]));
    return max;
}
module.exports = {
    coordinates,
    contains,
    sourceLevel,
    indexTiles,
    samplePatch,
    projectPatch,
    outline,
    difference,
    side
};
