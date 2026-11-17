// OpenMapTiles building footprints -> batched globe geometry, off the render thread.
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import earcut from "earcut";
import math from "./math.js";
const R = math.R,
    TAU = Math.PI * 2;
export function signedArea(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        sum += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    return sum / 2;
}
export function polygons(rings) {
    const result = [];
    let current, sign;
    for (let ring of rings) {
        if (ring.length > 1 && ring[0].x === ring.at(-1).x && ring[0].y === ring.at(-1).y)
            ring = ring.slice(0, -1);
        const area = signedArea(ring);
        if (ring.length < 3 || !area) continue;
        if (sign === undefined) sign = Math.sign(area);
        if (Math.sign(area) === sign) {
            current = [ring];
            result.push(current);
        } else if (current) current.push(ring);
    }
    return result;
}
function world(x, y, z, tileX, tileY, extent, height = 0) {
    const lon = ((tileX + x / extent) / 2 ** z - 0.5) * TAU;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + y / extent)) / 2 ** z)));
    const radius = R + height;
    return [
        radius * Math.cos(lat) * Math.cos(lon),
        radius * Math.cos(lat) * Math.sin(lon),
        radius * Math.sin(lat)
    ];
}
export function buildTile(buffer, z, x, y) {
    const layer = new VectorTile(new Pbf(new Uint8Array(buffer))).layers.building;
    const extent = layer?.extent || 4096,
        origin = world(extent / 2, extent / 2, z, x, y, extent);
    const pos = [],
        normals = [],
        uv = [],
        base = [],
        colors = [],
        seeds = [],
        tileUv = [];
    let count = 0;
    const vertex = (p, normal, wallUv, center, color, seed, xy) => {
        pos.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
        normals.push(...normal);
        uv.push(...wallUv);
        base.push(...center);
        colors.push(...color);
        seeds.push(seed);
        tileUv.push(xy.x / extent, xy.y / extent);
    };
    const triangle = (points, tex, center, color, seed, xy, desired) => {
        const a = points[1].map((v, i) => v - points[0][i]),
            b = points[2].map((v, i) => v - points[0][i]);
        let n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const length = Math.hypot(...n);
        if (length < 1e-8) return;
        n = n.map(v => v / length);
        const order =
            desired && n.reduce((sum, v, i) => sum + v * desired[i], 0) < 0 ? [0, 2, 1] : [0, 1, 2];
        if (order[1] === 2) n = n.map(v => -v);
        for (const i of order) vertex(points[i], n, tex[i], center, color, seed, xy[i]);
    };
    for (let i = 0; i < (layer?.length || 0); i++) {
        const feature = layer.feature(i),
            props = feature.properties;
        if (feature.type !== 3 || props.hide_3d === true || props.hide_3d === "true") continue;
        const height = Math.max(2, Math.min(1000, Number(props.render_height) || 6));
        const bottom = Math.max(0, Math.min(height, Number(props.render_min_height) || 0));
        if (bottom >= height) continue;
        const seed = ((feature.id || i + 1) % 65521) / 65521;
        let color = [0.48 + seed * 0.1, 0.47 + seed * 0.1, 0.44 + seed * 0.12];
        if (/^#[\da-f]{6}$/i.test(props.colour || ""))
            color = [1, 3, 5].map(n => parseInt(props.colour.slice(n, n + 2), 16) / 255);
        for (const rings of polygons(feature.loadGeometry())) {
            const outer = rings[0],
                center = [
                    outer.reduce((s, p) => s + p.x, 0) / outer.length / extent,
                    outer.reduce((s, p) => s + p.y, 0) / outer.length / extent
                ];
            if (center[0] < -0.1 || center[0] > 1.1 || center[1] < -0.1 || center[1] > 1.1)
                continue;
            const flat = [],
                holes = [],
                points = [];
            let offset = 0;
            for (let r = 0; r < rings.length; r++) {
                if (r) holes.push(offset);
                for (const p of rings[r]) {
                    flat.push(p.x, p.y);
                    points.push(p);
                    offset++;
                }
            }
            const roof = points.map(p => world(p.x, p.y, z, x, y, extent, height));
            const indices = earcut(flat, holes, 2);
            for (let k = 0; k < indices.length; k += 3) {
                const ids = indices.slice(k, k + 3);
                triangle(
                    ids.map(j => roof[j]),
                    [
                        [0, -1],
                        [0, -1],
                        [0, -1]
                    ],
                    center,
                    color,
                    seed,
                    ids.map(j => points[j]),
                    origin
                );
            }
            for (const ring of rings) {
                let along = 0;
                for (let j = 0; j < ring.length; j++) {
                    const a = ring[j],
                        b = ring[(j + 1) % ring.length];
                    const pa = world(a.x, a.y, z, x, y, extent, bottom),
                        pb = world(b.x, b.y, z, x, y, extent, bottom);
                    const qa = world(a.x, a.y, z, x, y, extent, height),
                        qb = world(b.x, b.y, z, x, y, extent, height);
                    const length = Math.hypot(...pb.map((v, k) => v - pa[k]));
                    const edge = pb.map((v, k) => v - pa[k]),
                        up = pa.map(v => v / Math.hypot(...pa));
                    // MVT exterior winding is clockwise when viewed from above the globe.
                    const desired = [
                        up[1] * edge[2] - up[2] * edge[1],
                        up[2] * edge[0] - up[0] * edge[2],
                        up[0] * edge[1] - up[1] * edge[0]
                    ].map(v => v * Math.sign(signedArea(outer)));
                    triangle(
                        [pa, pb, qb],
                        [
                            [along, bottom],
                            [along + length, bottom],
                            [along + length, height]
                        ],
                        center,
                        color,
                        seed,
                        [a, b, b],
                        desired
                    );
                    triangle(
                        [pa, qb, qa],
                        [
                            [along, bottom],
                            [along + length, height],
                            [along, height]
                        ],
                        center,
                        color,
                        seed,
                        [a, b, a],
                        desired
                    );
                    along += length;
                }
            }
            count++;
        }
    }
    return {
        origin,
        count,
        position: new Float32Array(pos),
        normal: new Float32Array(normals),
        uv: new Float32Array(uv),
        baseUv: new Float32Array(base),
        color: new Float32Array(colors),
        seed: new Float32Array(seeds),
        tileUv: new Float32Array(tileUv)
    };
}
