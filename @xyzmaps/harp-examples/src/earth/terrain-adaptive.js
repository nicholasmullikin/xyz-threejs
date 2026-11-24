const martini = require("@mapbox/martini");
const Martini = martini.default ?? martini;
const { perimeterIndices, skirtIndexBuffer } = require("./terrain-grid");
const { updateTerrainErrors } = require("./terrain-errors");
const engines = new Map();
function thresholdForBudget(errors, tolerance, capacity, scratch) {
    let count = 0;
    for (const error of errors) if (error > tolerance) scratch[count++] = error;
    if (count <= capacity) return tolerance;
    // Three-way partition keeps repeated propagated errors, including mandatory
    // shared-edge splits, together when selecting the upper quantile.
    const rank = count - capacity - 1;
    let left = 0, right = count - 1;
    while (left < right) {
        const pivot = scratch[(left + right) >>> 1];
        let lo = left, i = left, hi = right;
        while (i <= hi) {
            const value = scratch[i];
            if (value < pivot) {
                scratch[i++] = scratch[lo];
                scratch[lo++] = value;
            } else if (value > pivot) {
                scratch[i] = scratch[hi];
                scratch[hi--] = value;
            } else i++;
        }
        if (rank < lo) right = lo - 1;
        else if (rank > hi) left = hi + 1;
        else return pivot;
    }
    return scratch[rank];
}

function makeAdaptiveTerrain(
    heights,
    imageWidth,
    imageHeight,
    key,
    segments,
    obb,
    radius,
    exaggeration
) {
    const width = segments + 1,
        count = width * width;
    let template = engines.get(width);
    if (!template) {
        const engine = new Martini(width);
        const edgeStep = segments >= 128 ? 2 : 1;
        const allEdges = perimeterIndices(width);
        const perimeter = allEdges.filter((_, j) => j % edgeStep === 0);
        const omitted = edgeStep === 1 ? [] : allEdges.filter((_, j) => j % edgeStep !== 0);
        // MARTINI propagates split errors from children to ancestors. The
        // additional splits needed for a complete edge are independent of the DEM.
        const mandatory = engine.createTile(new Float32Array(count));
        for (const i of perimeter) mandatory.errors[i] = Infinity;
        mandatory.update();
        const forced = [];
        for (let i = 0; i < count; i++) if (mandatory.errors[i] === Infinity) forced.push(i);
        template = {
            tile: mandatory,
            perimeter,
            omitted,
            edgeWidth: segments / edgeStep + 1,
            forced,
            heightsAtVertex: new Float32Array(count),
            metric: mandatory.terrain,
            used: new Uint32Array(count)
        };
        engines.set(width, template);
    }
    const { tile, perimeter, forced, heightsAtVertex, metric, used } = template;
    const cols = new Float64Array(width),
        sinLon = new Float64Array(width),
        cosLon = new Float64Array(width);
    const sinLat = new Float64Array(width),
        cosLat = new Float64Array(width),
        slopeScale = new Float64Array(width);
    const world = 2 ** key.level;
    for (let i = 0; i < width; i++) {
        const t = i / segments;
        cols[i] = Math.max(0, Math.min(imageWidth - 1, t * imageWidth - 0.5));
        const lon = (((key.column + t) / world) * 2 - 1) * Math.PI;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (key.row + t)) / world)));
        sinLon[i] = Math.sin(lon);
        cosLon[i] = Math.cos(lon);
        sinLat[i] = Math.sin(lat);
        cosLat[i] = Math.cos(lat);
        slopeScale[i] = world * segments / (4 * Math.PI * radius * cosLat[i]);
    }
    const up = obb.zAxis,
        origin = obb.position,
        base = origin.x * up.x + origin.y * up.y + origin.z * up.z;
    for (let y = 0; y < width; y++) {
        const ty = Math.max(0, Math.min(imageHeight - 1, (y / segments) * imageHeight - 0.5)),
            iy = Math.floor(ty),
            fy = ty - iy;
        const top = iy * imageWidth,
            bottom = Math.min(imageHeight - 1, iy + 1) * imageWidth;
        for (let x = 0; x < width; x++) {
            const ix = Math.floor(cols[x]),
                right = Math.min(imageWidth - 1, ix + 1),
                fx = cols[x] - ix;
            const h =
                ((heights[top + ix] * (1 - fx) + heights[top + right] * fx) * (1 - fy) +
                    (heights[bottom + ix] * (1 - fx) + heights[bottom + right] * fx) * fy) *
                exaggeration;
            const i = y * width + x;
            heightsAtVertex[i] = h;
            metric[i] =
                (radius + h) *
                    (cosLat[y] * (cosLon[x] * up.x + sinLon[x] * up.y) + sinLat[y] * up.z) -
                base;
        }
    }
    updateTerrainErrors(metric, tile.errors, width);
    for (const i of forced) tile.errors[i] = Infinity;
    // Neighboring tiles use a common boundary density. Interior DEM samples
    // can refine one additional level without doubling every skirt and seam.
    for (const i of template.omitted) tile.errors[i] = 0;
    const extent = (2 * Math.PI * radius * cosLat[segments >> 1]) / world;
    const tolerance =
        segments === 256 ? Math.max(0.4, extent / 1024) : Math.max(0.15, extent / 2048);
    let mesh;
    // Very rough DEMs may exceed the regular mesh they replace even after
    // simplification. Keep a separate interior budget; all edge samples survive.
    const maxTriangles = segments === 256 ? 24_000 : 5_800;
    if (key.level >= 8 && key.level < 14 && segments === 128) {
        // A triangulated disk has 2V - B - 2 triangles. The four corners are
        // unconditional, and propagated midpoint errors rank the remaining
        // vertices without allocating a first mesh that exceeds the budget.
        const capacity = Math.floor((maxTriangles + perimeter.length + 2) / 2) - 4;
        const scratch = (template.scratch ??= new Float32Array(count));
        mesh = tile.getMesh(thresholdForBudget(tile.errors, tolerance, capacity, scratch));
    } else {
        mesh = tile.getMesh(tolerance);
        if (mesh.triangles.length / 3 > maxTriangles) {
            const ratio = mesh.triangles.length / (3 * maxTriangles);
            mesh = tile.getMesh(tolerance * Math.max(1.4, ratio ** 1.5));
        }
    }
    const { vertices, triangles } = mesh;
    const surfaceCount = vertices.length / 2;
    used.fill(0);
    for (let i = 0; i < vertices.length; i += 2) used[vertices[i + 1] * width + vertices[i]] = 1;
    const total = surfaceCount + 2 * perimeter.length,
        positions = new Float32Array(total * 3),
        uv = new Float32Array(total * 2),
        normals = new Int16Array(total * 3);

    let output = 0;
    function emit(i) {
        const x = i % width,
            y = Math.floor(i / width),
            r = radius + heightsAtVertex[i];
        const wx = r * cosLat[y] * cosLon[x] - origin.x,
            wy = r * cosLat[y] * sinLon[x] - origin.y,
            wz = r * sinLat[y] - origin.z;
        positions[output * 3] = wx * obb.xAxis.x + wy * obb.xAxis.y + wz * obb.xAxis.z;
        positions[output * 3 + 1] = wx * obb.yAxis.x + wy * obb.yAxis.y + wz * obb.yAxis.z;
        positions[output * 3 + 2] = wx * up.x + wy * up.y + wz * up.z;
        // Differentiate the sampled height surface in meters. The spherical
        // tangent basis rotates across a tile, particularly at high latitudes.
        const left = x > 0 ? i - 1 : i,
            right = x < segments ? i + 1 : i;
        const top = y > 0 ? i - width : i,
            bottom = y < segments ? i + width : i;
        const scale = slopeScale[y];
        const east = (heightsAtVertex[left] - heightsAtVertex[right]) * scale *
            (x === 0 || x === segments ? 2 : 1);
        const north = (heightsAtVertex[bottom] - heightsAtVertex[top]) * scale *
            (y === 0 || y === segments ? 2 : 1);
        const horizontal = cosLat[y] - sinLat[y] * north;
        const nx = horizontal * cosLon[x] - sinLon[x] * east;
        const ny = horizontal * sinLon[x] + cosLon[x] * east;
        const nz = sinLat[y] + cosLat[y] * north;
        const packedScale = 32767 / Math.sqrt(1 + east * east + north * north);
        normals[3 * output] = Math.round((nx * obb.xAxis.x + ny * obb.xAxis.y + nz * obb.xAxis.z) * packedScale);
        normals[3 * output + 1] = Math.round((nx * obb.yAxis.x + ny * obb.yAxis.y + nz * obb.yAxis.z) * packedScale);
        normals[3 * output + 2] = Math.round((nx * up.x + ny * up.y + nz * up.z) * packedScale);
        uv[output * 2] = x / segments;
        uv[output * 2 + 1] = 1 - y / segments;
        used[i] = output++;
    }
    for (const i of perimeter) emit(i);
    for (let y = 1; y < segments; y++)
        for (let x = 1; x < segments; x++) {
            const i = y * width + x;
            if (used[i]) emit(i);
        }
    const remap = new Uint32Array(surfaceCount);
    for (let i = 0; i < surfaceCount; i++)
        remap[i] = used[vertices[i * 2 + 1] * width + vertices[i * 2]];
    const Index = total > 65536 ? Uint32Array : Uint16Array;
    const main = new Index(triangles.length);
    for (let i = 0; i < main.length; i++) main[i] = remap[triangles[i]];
    for (let j = 0; j < perimeter.length; j++) {
        const target = 2 * (surfaceCount + 2 * j);
        uv[target] = uv[target + 2] = uv[j * 2];
        uv[target + 1] = uv[target + 3] = uv[j * 2 + 1];
    }
    return {
        width,
        surfaceCount,
        edgeWidth: template.edgeWidth,
        positions,
        normals,
        uv,
        index: skirtIndexBuffer(main, surfaceCount, perimeter.length)
    };
}
module.exports = { makeAdaptiveTerrain };
