// The compact mesh stores its clockwise perimeter first, followed by the
// retained interior vertices in row order. A bit per possible grid vertex
// plus one prefix sum per word locates a retained vertex without a dense map.
const layouts = new WeakMap();
function popcount(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
function terrainTopology(geometry) {
    const meta = geometry.userData?.attributeMetadata?.position;
    if (!meta?.terrainSurfaceCount) return;
    let topology = layouts.get(geometry);
    if (topology) return topology;
    const width = meta.terrainGridWidth,
        n = width - 1;
    const edgeSegments = (meta.terrainEdgeWidth ?? width) - 1;
    const uv = geometry.attributes.uv;
    const mask = new Uint32Array(Math.ceil((width * width) / 32));
    for (let i = 4 * edgeSegments; i < meta.terrainSurfaceCount; i++) {
        const x = Math.round(n * uv.getX(i)),
            y = Math.round(n * (1 - uv.getY(i)));
        const code = y * width + x;
        mask[code >>> 5] |= 1 << (code & 31);
    }
    const rank = new Uint32Array(mask.length);
    let total = 4 * edgeSegments;
    for (let word = 0; word < mask.length; word++) {
        rank[word] = total;
        total += popcount(mask[word]);
    }
    topology = { mask, rank, edgeStep: n / edgeSegments };
    layouts.set(geometry, topology);
    return topology;
}
function perimeterIndex(x, y, n) {
    if (y === 0) return x;
    if (x === n) return n + y;
    if (y === n) return 3 * n - x;
    if (x === 0) return 4 * n - y;
    return -1;
}
function compactVertex(topology, x, y, n) {
    const edge = perimeterIndex(x, y, n);
    if (edge !== -1) return edge % topology.edgeStep ? -1 : edge / topology.edgeStep;
    const code = y * (n + 1) + x,
        word = code >>> 5,
        bit = 1 << (code & 31),
        bits = topology.mask[word];
    if (!(bits & bit)) return -1;
    return topology.rank[word] + popcount(bits & (bit - 1));
}
// Sample the same three vertex normals and optional transition as the vertex shader.
function sampleNormal(surface, a, b, c, wa, wb, wc, out) {
    const normals = surface.normals, scale = surface.normalScale;
    const morph = surface.morph, factor = morph?.normalFactor;
    const delta = morph?.normalDelta;
    for (let axis = 0; axis < 3; axis++) {
        const i = a + axis, j = b + axis, k = c + axis;
        const native = (normals[i] * wa + normals[j] * wb + normals[k] * wc) * scale;
        out[axis] = factor ? native + (delta[i] * wa + delta[j] * wb + delta[k] * wc) * factor : native;
    }
}
function samplePosition(surface, u, v, out, normal) {
    const n = surface.width - 1,
        p = surface.positions,
        topology = surface.topology;
    const x = Math.min(n, Math.max(0, u * n)),
        y = Math.min(n, Math.max(0, v * n));
    let a, b, c, wa, wb, wc;
    if (topology) {
        // Dyadic parent crops frequently land exactly on a retained grid vertex.
        if (Number.isInteger(x) && Number.isInteger(y)) {
            const vertex = compactVertex(topology, x, y, n);
            if (vertex >= 0) {
                const index = vertex * 3;
                out.x = p[index];
                out.y = p[index + 1];
                out.z =
                    p[index + 2] +
                    (surface.morph ? surface.morph.factor * surface.morph.delta[vertex] : 0);
                if (normal) sampleNormal(surface, index, index, index, 1, 0, 0, normal);
                return out;
            }
        }
        // MARTINI's two right triangles bisect their hypotenuse recursively.
        // A retained midpoint identifies a split on either side of a diamond.
        let ax = 0,
            ay = 0,
            bx = n,
            by = n,
            cx = n,
            cy = 0;
        if (y > x) {
            ax = n;
            ay = n;
            bx = 0;
            by = 0;
            cx = 0;
            cy = n;
        }
        while (Math.abs(ax - cx) + Math.abs(ay - cy) > 1) {
            const mx = (ax + bx) >> 1,
                my = (ay + by) >> 1;
            if (compactVertex(topology, mx, my, n) < 0) break;
            const dx = mx - cx,
                dy = my - cy;
            if ((dx * (y - cy) - dy * (x - cx)) * (dx * (ay - cy) - dy * (ax - cx)) >= 0) {
                bx = ax;
                by = ay;
                ax = cx;
                ay = cy;
            } else {
                ax = bx;
                ay = by;
                bx = cx;
                by = cy;
            }
            cx = mx;
            cy = my;
        }
        a = compactVertex(topology, ax, ay, n);
        b = compactVertex(topology, bx, by, n);
        c = compactVertex(topology, cx, cy, n);
        const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        wb = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / det;
        wc = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / det;
        wa = 1 - wb - wc;
    } else {
        const col = Math.min(n - 1, Math.floor(x)),
            row = Math.min(n - 1, Math.floor(y)),
            fx = x - col,
            fy = y - row;
        const tl = row * surface.width + col;
        const diagonal = surface.diagonal;
        if (diagonal && ((col + row) % 2 === 0) === diagonal > 0) {
            a = tl;
            c = tl + surface.width + 1;
            if (fy >= fx) {
                b = tl + surface.width;
                wa = 1 - fy;
                wb = fy - fx;
                wc = fx;
            } else {
                b = tl + 1;
                wa = 1 - fx;
                wb = fx - fy;
                wc = fy;
            }
        } else {
            b = tl + 1;
            c = tl + surface.width;
            const lower = fx + fy > 1;
            a = lower ? c + 1 : tl;
            wa = lower ? fx + fy - 1 : 1 - fx - fy;
            wb = lower ? 1 - fy : fx;
            wc = lower ? 1 - fx : fy;
        }
    }
    const morph = surface.morph;
    const dz = morph
        ? morph.factor * (morph.delta[a] * wa + morph.delta[b] * wb + morph.delta[c] * wc)
        : 0;
    a *= 3;
    b *= 3;
    c *= 3;
    if (normal) sampleNormal(surface, a, b, c, wa, wb, wc, normal);
    out.x = p[a] * wa + p[b] * wb + p[c] * wc;
    out.y = p[a + 1] * wa + p[b + 1] * wb + p[c + 1] * wc;
    out.z = p[a + 2] * wa + p[b + 2] * wb + p[c + 2] * wc + dz;
    return out;
}
module.exports = { terrainTopology, perimeterIndex, samplePosition };
