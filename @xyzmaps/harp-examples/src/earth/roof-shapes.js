// Geometry in the MVT tangent plane. The min of a small set of linear ramps
// gives a continuous roof surface. Clip the footprint's existing triangulation
// to each ramp and pitch change, preserving courtyards and concave boundaries.
const names = [
    "",
    "gabled",
    "hipped",
    "half-hipped",
    "pyramidal",
    "skillion",
    "gambrel",
    "mansard",
    "round",
    "dome",
    "onion",
    "cone",
    "saltbox"
];
const linear = [
    [0, 0],
    [1, 1]
];
const curved = [
    [0, 0],
    [0.08, 0.39],
    [0.25, 0.66],
    [0.5, 0.866],
    [0.75, 0.968],
    [1, 1]
];
const gambrel = [
    [0, 0],
    [0.31, 0.72],
    [1, 1]
];
const onion = [
    [0, 0],
    [0.14, 0.33],
    [0.42, 0.6],
    [0.74, 0.75],
    [1, 1]
];
const value = (plane, p) => plane[0] * p.x + plane[1] * p.y + plane[2];
const between = (a, b, t) => ({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
function clip(points, plane) {
    const output = [];
    let before = points[points.length - 1],
        start = value(plane, before);
    for (const after of points) {
        const end = value(plane, after);
        if (start < 0 !== end < 0) output.push(between(before, after, start / (start - end)));
        if (end >= 0) output.push(after);
        before = after;
        start = end;
    }
    return output;
}
function orientedBounds(points, across, bearing) {
    if (Number.isFinite(bearing)) {
        // MVT +Y points south. A documented roof:direction is downhill, so
        // the increasing skillion plane points in the opposite direction.
        const angle = (bearing * Math.PI) / 180,
            x = Math.cos(angle),
            y = Math.sin(angle);
        const axis = (dx, dy) => {
            let lo = Infinity,
                hi = -Infinity;
            for (const p of points) {
                const t = dx * p.x + dy * p.y;
                lo = Math.min(lo, t);
                hi = Math.max(hi, t);
            }
            const span = hi - lo;
            return { span, plane: [(2 * dx) / span, (2 * dy) / span, -(hi + lo) / span] };
        };
        const ridge = axis(x, y),
            slope = axis(-y, x);
        if (Math.min(ridge.span, slope.span) <= 0) return;
        return {
            u: ridge.plane,
            v: slope.plane,
            du: ridge.span,
            dv: slope.span,
            area: ridge.span * slope.span
        };
    }
    // Minimum-area oriented box. A footprint with many digitized points needs
    // only its convex hull to find candidate axes and support distances.
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    function chain(points) {
        const out = [];
        for (const p of points) {
            while (out.length > 1) {
                const b = out[out.length - 1],
                    a = out[out.length - 2];
                if ((b.x - a.x) * (p.y - a.y) > (b.y - a.y) * (p.x - a.x)) break;
                out.pop();
            }
            out.push(p);
        }
        out.pop();
        return out;
    }
    const hull = chain(sorted).concat(chain(sorted.reverse()));
    if (hull.length < 3) return;
    let best;
    for (let i = 0; i < hull.length; i++) {
        const a = hull[i],
            b = hull[(i + 1) % hull.length],
            len = Math.hypot(b.x - a.x, b.y - a.y);
        if (!len) continue;
        const x = (b.x - a.x) / len,
            y = (b.y - a.y) / len;
        let loU = Infinity,
            hiU = -Infinity,
            loV = Infinity,
            hiV = -Infinity;
        for (const p of hull) {
            const u = x * p.x + y * p.y,
                v = -y * p.x + x * p.y;
            loU = Math.min(loU, u);
            hiU = Math.max(hiU, u);
            loV = Math.min(loV, v);
            hiV = Math.max(hiV, v);
        }
        const du = hiU - loU,
            dv = hiV - loV,
            area = du * dv;
        if (area <= 0 || (best && area >= best.area - 0.00001)) continue;
        const u = [(2 * x) / du, (2 * y) / du, -(hiU + loU) / du];
        const v = [(-2 * y) / dv, (2 * x) / dv, -(hiV + loV) / dv];
        best = du >= dv !== across ? { u, v, du, dv, area } : { u: v, v: u, du: dv, dv: du, area };
    }
    return best;
}
function ramp(axis, offset, slope) {
    return [axis[0] * slope, axis[1] * slope, offset + axis[2] * slope];
}
function surface(kind, box) {
    const { u, v } = box;
    const aspect = box.du / box.dv;
    const planes =
        kind === "skillion"
            ? [ramp(v, 0.5, 0.5)]
            : kind === "saltbox"
              ? [ramp(v, 1 / 0.75, 1 / 0.75), ramp(v, 1 / 1.25, -1 / 1.25)]
              : [ramp(v, 1, 1), ramp(v, 1, -1)];
    if (["hipped", "half-hipped", "pyramidal", "mansard"].includes(kind)) {
        const scale = kind === "pyramidal" || kind === "mansard" ? 1 : aspect;
        const offset = scale + (kind === "half-hipped" ? 0.45 : 0);
        planes.push(ramp(u, offset, scale), ramp(u, offset, -scale));
    }
    if (["dome", "cone", "onion"].includes(kind)) {
        planes.length = 0;
        for (let i = 0; i < 12; i++) {
            const angle = (i * Math.PI) / 6,
                cos = Math.cos(angle),
                sin = Math.sin(angle);
            planes.push(u.map((n, k) => (k === 2 ? 1 : 0) - cos * n - sin * v[k]));
        }
    }
    const profile =
        kind === "round" || kind === "dome"
            ? curved
            : kind === "gambrel" || kind === "mansard"
              ? gambrel
              : kind === "onion"
                ? onion
                : linear;
    return { planes, profile };
}
function pitch(profile, r) {
    if (r <= 0) return 0;
    for (let i = 1; i < profile.length; i++) {
        const [end, high] = profile[i],
            [start, low] = profile[i - 1];
        if (r <= end) return low + ((r - start) / (end - start)) * (high - low);
    }
    return 1;
}
function buildRoof(tag, rings, points, indices, height, bottom, metresPerUnit) {
    const kind = names[tag.shape],
        outer = rings[0];
    if (!kind || outer.length > 512 || !indices.length) return;
    const box = orientedBounds(outer, tag.across, tag.bearing);
    if (!box || box.dv * metresPerUnit < 0.7) return;
    const typical = (kind === "dome" || kind === "onion" ? 0.48 : 0.27) * box.dv * metresPerUnit;
    let rise = tag.rise > 0 ? tag.rise : Math.max(0.6, Math.min(9, typical));
    let eaves = height;
    if (tag.measured) {
        rise = Math.min(rise, (tag.rise > 0 ? 1 : 0.7) * (height - bottom));
        eaves = height - rise;
    }
    const { planes, profile } = surface(kind, box);
    const roofHeight = p =>
        eaves + rise * pitch(profile, Math.min(...planes.map(t => value(t, p))));
    const faces = [];
    const cuts = planes.map((plane, i) =>
        planes.flatMap((other, j) => (i === j ? [] : [other.map((x, k) => x - plane[k])]))
    );
    for (let k = 0; k < indices.length; k += 3) {
        const triangle = [points[indices[k]], points[indices[k + 1]], points[indices[k + 2]]];
        for (let i = 0; i < planes.length; i++) {
            let region = triangle;
            for (const boundary of cuts[i]) {
                region = clip(region, boundary);
                if (region.length < 3) break;
            }
            if (region.length < 3) continue;
            const plane = planes[i];
            // A circular footprint can lie just outside the fitted polygonal
            // dome. Keep the outer ring at eave height instead of leaving holes.
            const bands =
                profile.length === 2 && planes.length <= 4
                    ? [[-Infinity, Infinity]]
                    : [
                          [-Infinity, 0],
                          ...profile.slice(1).map(([end], j) => [profile[j][0], end]),
                          [1, Infinity]
                      ];
            for (const [lo, hi] of bands) {
                let polygon = region;
                if (Number.isFinite(lo))
                    polygon = clip(polygon, [plane[0], plane[1], plane[2] - lo]);
                if (polygon.length < 3) continue;
                if (Number.isFinite(hi))
                    polygon = clip(polygon, [-plane[0], -plane[1], hi - plane[2]]);
                for (let j = 2; j < polygon.length; j++) {
                    const [a, b, c] = [polygon[0], polygon[j - 1], polygon[j]];
                    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
                    if (Math.abs(area) < 1e-7) continue;
                    faces.push(
                        [a, b, c].map(p => ({
                            ...p,
                            z: eaves + rise * pitch(profile, value(plane, p))
                        }))
                    );
                }
            }
        }
    }
    // Split the vertical gable ends at the same ridge and profile breaks.
    const walls = rings.map(ring =>
        ring.flatMap((p, i) => {
            const q = ring[(i + 1) % ring.length],
                at = [0];
            const start = planes.map(t => value(t, p)),
                end = planes.map(t => value(t, q));
            function cutAt(a, b) {
                if (a * b < 0) at.push(a / (a - b));
            }
            for (let k = 0; k < planes.length; k++) {
                for (let j = k + 1; j < planes.length; j++)
                    cutAt(start[k] - start[j], end[k] - end[j]);
                for (const [v] of profile) cutAt(start[k] - v, end[k] - v);
            }
            at.sort((a, b) => a - b);
            const samples = at
                .filter((t, i) => !i || t - at[i - 1] > 1e-6)
                .map(t => {
                    const xy = between(p, q, t);
                    return { ...xy, z: roofHeight(xy) };
                });
            // Drop event locations on inactive planes along this edge.
            const last = { ...q, z: roofHeight(q) };
            return samples.filter((b, j) => {
                if (!j) return true;
                const a = samples[j - 1],
                    c = samples[j + 1] || last;
                const f =
                    Math.hypot(b.x - a.x, b.y - a.y) /
                    Math.max(1e-12, Math.hypot(c.x - a.x, c.y - a.y));
                return Math.abs(b.z - (a.z + (c.z - a.z) * f)) > 0.00001;
            });
        })
    );
    return { faces, walls };
}
module.exports = { names, buildRoof, orientedBounds };
