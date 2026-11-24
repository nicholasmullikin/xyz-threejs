const radius = 6378137,
    world = 2 * Math.PI * radius;
function coordinates(lat, lon) {
    return [(lon + 180) / 360, (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2];
}
function tileFrame(x, y, z) {
    const n = 2 ** z,
        span = world / n,
        lon = ((x + 0.5) / n - 0.5) * 2 * Math.PI,
        lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
    return {
        lon,
        lat,
        west: x * span - world / 2,
        north: world / 2 - y * span,
        span,
        metres: span * Math.cos(lat)
    };
}
function inside(ring, x, y) {
    let hit = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        const xi = ring[i],
            yi = ring[i + 1],
            xj = ring[j],
            yj = ring[j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
}
function surveyAt(list, x, y) {
    return list.find(row =>
        row[3].some(
            poly => inside(poly[0], x, y) && !poly.slice(1).some(ring => inside(ring, x, y))
        )
    )?.[0];
}
function possibleNodes(ept, frame, elevation, spacing) {
    const b = ept.bounds,
        scale = b[3] - b[0],
        nativeSpacing = spacing / Math.cos(frame.lat);
    const finest = Math.max(
        0,
        Math.min(18, Math.ceil(Math.log2(scale / ept.span / nativeSpacing)))
    );
    const result = [];
    for (let d = Math.max(0, finest - 3); d <= finest; d++) {
        const n = 2 ** d,
            size = scale / n;
        const range = (w, e, origin) => [
            Math.max(0, Math.floor((w - origin) / size)),
            Math.min(n - 1, Math.floor((e - origin) / size))
        ];
        const extra = frame.span / 64,
            [x0, x1] = range(frame.west - extra, frame.west + frame.span + extra, b[0]);
        const [y0, y1] = range(frame.north - frame.span - extra, frame.north + extra, b[1]);
        const [z0, z1] = range(elevation - 90, elevation + 300, b[2]);
        const level = [];
        for (let x = x0; x <= x1; x++)
            for (let y = y0; y <= y1; y++)
                for (let z = z0; z <= z1; z++)
                    level.push({
                        d,
                        x,
                        y,
                        z,
                        key: [d, x, y, z].join("-"),
                        distance: Math.abs(b[2] + (z + 0.5) * size - elevation)
                    });
        level.sort((a, b) => a.distance - b.distance);
        result.push(...level);
    }
    return result;
}
function createRaster(divisions) {
    const side = divisions + 1,
        size = side * side;
    const high = new Float32Array(size).fill(-Infinity),
        second = new Float32Array(size).fill(-Infinity),
        count = new Uint16Array(size);
    function add(u, v, z) {
        const x = Math.round(u * divisions),
            y = Math.round(v * divisions);
        if (x < 0 || y < 0 || x > divisions || y > divisions) return;
        const i = y * side + x;
        if (z >= high[i]) {
            second[i] = high[i];
            high[i] = z;
        } else if (z > second[i]) second[i] = z;
        if (count[i] < 65535) count[i]++;
    }
    function observations() {
        const samples = new Float32Array(size).fill(NaN);
        for (let i = 0; i < size; i++) {
            if (count[i] >= 2) samples[i] = high[i] - second[i] > 1.5 ? second[i] : high[i];
        }
        return samples;
    }
    function mesh(metres, tolerance = 0) {
        const sampled = high.slice(),
            out = high.slice();
        let covered = 0;
        for (let i = 0; i < size; i++)
            if (count[i]) {
                covered++;
                if (count[i] > 2 && high[i] - second[i] > 4) sampled[i] = second[i];
            }
        if (covered / size < 0.13) return;
        // Fill only local sampling gaps. Large gaps, water without returns,
        // and the survey boundary continue to show the ordinary globe.
        for (let y = 0; y < side; y++)
            for (let x = 0; x < side; x++) {
                const i = y * side + x,
                    observed = sampled[i],
                    near = [];
                for (let dy = -1; dy <= 1; dy++)
                    for (let dx = -1; dx <= 1; dx++) {
                        if (
                            (dx === 0 && dy === 0) ||
                            x + dx < 0 ||
                            x + dx >= side ||
                            y + dy < 0 ||
                            y + dy >= side
                        )
                            continue;
                        const h = sampled[i + dx + dy * side];
                        if (Number.isFinite(h)) near.push(h);
                    }
                if (near.length < 3) {
                    out[i] = observed;
                    continue;
                }
                near.sort((a, b) => a - b);
                const med = near[near.length >> 1];
                out[i] =
                    !Number.isFinite(observed) ||
                    (near.length >= 5 &&
                        Math.abs(med - observed) > 5 &&
                        near.every(value => Math.abs(value - observed) > 3))
                        ? med
                        : observed;
            }
        const pos = new Float32Array(size * 3),
            normals = new Float32Array(size * 3),
            index = [];
        let lo = Infinity,
            hi = -Infinity;
        for (let y = 0; y < side; y++)
            for (let x = 0; x < side; x++) {
                const i = y * side + x,
                    h = out[i];
                pos[3 * i] = (x / divisions - 0.5) * metres;
                pos[3 * i + 1] = (0.5 - y / divisions) * metres;
                pos[3 * i + 2] = Number.isFinite(h) ? h : 0;
                if (Number.isFinite(h)) {
                    lo = Math.min(lo, h);
                    hi = Math.max(hi, h);
                }
            }
        function face(a, b, c) {
            if (!Number.isFinite(out[a]) || !Number.isFinite(out[b]) || !Number.isFinite(out[c]))
                return;
            index.push(a, b, c);
            const ia = a * 3,
                ib = b * 3,
                ic = c * 3;
            const x = pos[ib] - pos[ia],
                y = pos[ib + 1] - pos[ia + 1],
                z = pos[ib + 2] - pos[ia + 2];
            const u = pos[ic] - pos[ia],
                v = pos[ic + 1] - pos[ia + 1],
                w = pos[ic + 2] - pos[ia + 2];
            for (const i of [ia, ib, ic]) {
                normals[i] += y * w - z * v;
                normals[i + 1] += z * u - x * w;
                normals[i + 2] += x * v - y * u;
            }
        }
        for (let y = 0; y < divisions; y++)
            for (let x = 0; x < divisions; x++) {
                const a = y * side + x,
                    b = a + 1,
                    c = a + side,
                    d = c + 1;
                if (Math.abs(out[a] - out[d]) < Math.abs(out[b] - out[c])) {
                    face(a, c, d);
                    face(a, d, b);
                } else {
                    face(a, c, b);
                    face(b, c, d);
                }
            }
        if (index.length < 128) return;
        const normal = new Int16Array(size * 3);
        for (let i = 0; i < size * 3; i += 3) {
            const k = 32767 / (Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1);
            normal[i] = Math.round(normals[i] * k);
            normal[i + 1] = Math.round(normals[i + 1] * k);
            normal[i + 2] = Math.round(normals[i + 2] * k);
        }
        const arrays =
            tolerance > 0 && divisions % 8 === 0
                ? require("./lidar-decimation").compactGround(pos, normal, out, side, tolerance)
                : { pos, normal, index: Uint16Array.from(index) };
        return {
            ...arrays,
            ground: out,
            divisions,
            trianglesBefore: index.length / 3,
            lo,
            hi,
            coverage: covered / size
        };
    }
    return { add, mesh, observations };
}
// Use the same diagonal as mesh generation, including the edges of holes.
function heightInGrid(grid, div, u, v) {
    if (u < 0 || v < 0 || u > 1 || v > 1) return;
    const x = Math.min(div - 1, Math.floor(u * div)),
        y = Math.min(div - 1, Math.floor(v * div)),
        a = y * (div + 1) + x;
    const dx = u * div - x,
        dy = v * div - y,
        h0 = grid[a],
        h1 = grid[a + 1],
        h2 = grid[a + div + 1],
        h3 = grid[a + div + 2];
    let value;
    if (Math.abs(h0 - h3) < Math.abs(h1 - h2)) {
        value =
            dx >= dy
                ? h0 * (1 - dx) + h1 * (dx - dy) + h3 * dy
                : h0 * (1 - dy) + h2 * (dy - dx) + h3 * dx;
    } else {
        value =
            dx + dy <= 1
                ? h0 * (1 - dx - dy) + h1 * dx + h2 * dy
                : h3 * (dx + dy - 1) + h1 * (1 - dy) + h2 * (1 - dx);
    }
    return Number.isFinite(value) ? value : undefined;
}
module.exports = { coordinates, tileFrame, surveyAt, possibleNodes, createRaster, heightInGrid };
