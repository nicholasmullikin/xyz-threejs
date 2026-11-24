// Coarsen locally planar ground while keeping every perimeter vertex. A fine
// neighbour or a sampling hole can meet a coarse block without a T-junction.
function compactGround(pos, normal, heights, side, tolerance) {
    const index = [],
        div = side - 1;
    const vertex = (x, y) => y * side + x,
        finite = i => Number.isFinite(heights[i]);
    function emit(a, b, c) {
        if (finite(a) && finite(b) && finite(c)) index.push(a, b, c);
    }
    function cell(x, y) {
        const a = vertex(x, y),
            b = a + 1,
            c = a + side,
            d = c + 1;
        if (Math.abs(heights[a] - heights[d]) < Math.abs(heights[b] - heights[c])) {
            emit(a, c, d);
            emit(a, d, b);
        } else {
            emit(a, c, b);
            emit(b, c, d);
        }
    }
    function canCollapse(x, y, w) {
        if (x < 2 || y < 2 || x + w > div - 2 || y + w > div - 2) return false;
        const half = w / 2,
            cx = x + half,
            cy = y + half,
            center = heights[vertex(cx, cy)];
        if (!Number.isFinite(center)) return false;
        for (let py = y; py <= y + w; py++)
            for (let px = x; px <= x + w; px++) {
                const h = heights[vertex(px, py)],
                    r = Math.max(Math.abs(px - cx), Math.abs(py - cy)) / half;
                if (!Number.isFinite(h)) return false;
                if (r === 0 || r === 1) continue;
                const ex = cx + (px - cx) / r,
                    ey = cy + (py - cy) / r;
                let lo, hi, u;
                if (Math.abs(px - cx) >= Math.abs(py - cy)) {
                    const bx = px < cx ? x : x + w;
                    lo = vertex(bx, Math.floor(ey));
                    hi = vertex(bx, Math.ceil(ey));
                    u = ey - Math.floor(ey);
                } else {
                    const by = py < cy ? y : y + w;
                    lo = vertex(Math.floor(ex), by);
                    hi = vertex(Math.ceil(ex), by);
                    u = ex - Math.floor(ex);
                }
                const outer = heights[lo] + u * (heights[hi] - heights[lo]);
                if (
                    !Number.isFinite(outer) ||
                    Math.abs(center + r * (outer - center) - h) > tolerance
                )
                    return false;
            }
        return true;
    }
    function block(x, y, w) {
        if (w === 2) {
            cell(x, y);
            cell(x + 1, y);
            cell(x, y + 1);
            cell(x + 1, y + 1);
            return;
        }
        if (!canCollapse(x, y, w)) {
            const h = w / 2;
            block(x, y, h);
            block(x + h, y, h);
            block(x, y + h, h);
            block(x + h, y + h, h);
            return;
        }
        const mid = vertex(x + w / 2, y + w / 2);
        for (let k = 0; k < w; k++) {
            emit(mid, vertex(x + k + 1, y), vertex(x + k, y));
            emit(mid, vertex(x + w, y + k + 1), vertex(x + w, y + k));
            emit(mid, vertex(x + k, y + w), vertex(x + k + 1, y + w));
            emit(mid, vertex(x, y + k), vertex(x, y + k + 1));
        }
    }
    for (let y = 0; y < div; y += 8) for (let x = 0; x < div; x += 8) block(x, y, 8);
    const remap = new Int32Array(side * side).fill(-1),
        used = [];
    for (let j = 0; j < index.length; j++) {
        const i = index[j];
        if (remap[i] === -1) {
            remap[i] = used.length;
            used.push(i);
        }
        index[j] = remap[i];
    }
    const positions = new Float32Array(3 * used.length),
        normals = new Int16Array(3 * used.length);
    used.forEach((i, j) => {
        for (let k = 0; k < 3; k++) {
            positions[3 * j + k] = pos[3 * i + k];
            normals[3 * j + k] = normal[3 * i + k];
        }
    });
    return { pos: positions, normal: normals, index: Uint16Array.from(index) };
}
module.exports = { compactGround };
