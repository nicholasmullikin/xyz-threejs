const { terrainTopology, samplePosition } = require("./terrain-sample");
const { gridWidth } = require("./terrain-grid");
/** Low resolution depth + UV feedback for choosing independent raster pages.
 * A sparse grid on each decoded DEM preserves parallax and most ridge occlusion
 * without a GPU readback. Nearest-depth interpolation matches the shader's
 * perspective-correct UVs. The full-resolution scene still uses every vertex.
 */
const COLUMNS = 24,
    GRID_SEGMENTS = 6,
    MAX_IMAGE_LEVEL = 20;
const PAGE_SIZE = 512;
const key = (z, x, y) => `${z}/${x}/${y}`;

// The screen pixel projects to an ellipse in source UV space. A grazing
// view can resolve a narrow strip across a road even when it covers many
// source texels along the road. Limit refinement to the available filter.
function pixelFootprint(ux, vx, uy, vy, anisotropy) {
    const xx = ux * ux + vx * vx,
        yy = uy * uy + vy * vy;
    if (anisotropy <= 1) return Math.sqrt(Math.max(xx, yy));
    const xy = ux * uy + vx * vy;
    const major = Math.sqrt((xx + yy + Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)) * 0.5);
    if (!major) return 0;
    const minor = Math.abs(ux * vy - uy * vx) / major;
    return Math.max(major / anisotropy, minor);
}

// Low-altitude views can see past a ridge that an overly sparse feedback
// mesh has flattened. Spend the extra triangles only where relief subtends
// a substantial angle at the camera; distant plains keep the cheapest grid.
function feedbackSegments(map, tile, geometry) {
    const height = geometry.userData?.attributeMetadata?.position;
    const bounds = tile.boundingBox?.extents;
    if (!height || !bounds || map.zoomLevel < 9) return GRID_SEGMENTS;
    const relief = height.maxHeight - height.minHeight;
    if (!(relief > 0)) return GRID_SEGMENTS;
    const radius = Math.hypot(bounds.x, bounds.y);
    const distance = Math.max(300, tile.center.distanceTo(map.camera.position) - 0.65 * radius);
    const angle = relief / distance;
    return angle > 0.12 ? 24 : angle > 0.035 ? 12 : GRID_SEGMENTS;
}

function createCoverage(THREE) {
    const projection = new THREE.Matrix4(),
        local = new THREE.Matrix4();
    const proxies = new WeakMap();
    // Tiles are rasterized serially. Share homogeneous clip and projected
    // vertex storage across them to avoid allocating two arrays per mesh.
    const points = [],
        projected = [],
        projectionPool = [];
    function proxy(geometry, requested) {
        const position = geometry.attributes.position;
        let stored = proxies.get(position);
        const morph = geometry.userData?.terrainTransition;
        if (!stored || stored.version !== position.version || stored.morphFactor !== morph?.factor) {
            stored = { version: position.version, morphFactor: morph?.factor, grids: new Map() };
            proxies.set(position, stored);
        }
        const width = gridWidth(geometry);
        if (!Number.isInteger(width) || width < 2) return;
        const segments = Math.min(requested, width - 1);
        if (stored.grids.has(segments)) return stored.grids.get(segments);
        const topology = terrainTopology(geometry),
            surface = { width, positions: position.array, topology, morph };
        const points = [];
        for (let j = 0; j <= segments; j++) {
            for (let i = 0; i <= segments; i++) {
                const col = Math.round((i * (width - 1)) / segments);
                const row = Math.round((j * (width - 1)) / segments);
                if (topology) {
                    const point = { u: col / (width - 1), v: row / (width - 1), x: 0, y: 0, z: 0 };
                    points.push(samplePosition(surface, point.u, point.v, point));
                    continue;
                }
                const index = col + row * width;
                points.push({
                    x: position.getX(index),
                    y: position.getY(index),
                    z: position.getZ(index) + (morph ? morph.factor * morph.delta[index] : 0),
                    u: col / (width - 1),
                    v: row / (width - 1)
                });
            }
        }
        const result = { points, segments };
        stored.grids.set(segments, result);
        return result;
    }
    return function sample(map, tiles, anisotropy = 1) {
        const width = map.canvas.width,
            height = map.canvas.height;
        if (!(width > 0 && height > 0)) return [];
        const cols = COLUMNS,
            rows = Math.max(6, Math.min(32, Math.round((cols * height) / width)));
        const samples = new Array(cols * rows),
            depths = new Float64Array(samples.length);
        projection.multiplyMatrices(map.camera.projectionMatrix, map.camera.matrixWorldInverse);
        for (const tile of tiles) {
            const mesh = tile.objects.find(o => o.isMesh && o.material?.userData.earthTerrain);
            const shape = mesh && proxy(mesh.geometry, feedbackSegments(map, tile, mesh.geometry));
            if (!shape) continue;
            if (tile.localTangentSpace) local.copy(tile.boundingBox.getRotationMatrix());
            else local.identity();
            local.setPosition(tile.center).premultiply(projection);
            const m = local.elements;
            // Clip before the perspective divide. Near-ground flights often
            // put tile corners behind the camera.
            const near = Math.max(0.1, map.camera.near);
            function project(p, out = {}) {
                const iw = 1 / p.w;
                out.x = ((p.x * iw + 1) * cols) / 2;
                out.y = ((1 - p.y * iw) * rows) / 2;
                out.iw = iw;
                out.u = p.u * iw;
                out.v = p.v * iw;
                return out;
            }
            for (let i = 0; i < shape.points.length; i++) {
                const { x, y, z, u, v } = shape.points[i];
                const p = (points[i] ??= {});
                p.x = m[0] * x + m[4] * y + m[8] * z + m[12];
                p.y = m[1] * x + m[5] * y + m[9] * z + m[13];
                p.w = m[3] * x + m[7] * y + m[11] * z + m[15];
                p.u = u;
                p.v = v;
                projected[i] = p.w < near ? null : project(p, (projectionPool[i] ??= {}));
            }
            const tk = tile.tileKey;
            function draw(a, b, c) {
                const abx = b.x - a.x,
                    aby = b.y - a.y,
                    acx = c.x - a.x,
                    acy = c.y - a.y;
                const det = abx * acy - aby * acx;
                if (Math.abs(det) < 1e-9) return;
                const minX = Math.max(0, Math.ceil(Math.min(a.x, b.x, c.x) - 0.5));
                const maxX = Math.min(cols - 1, Math.floor(Math.max(a.x, b.x, c.x) - 0.5));
                const minY = Math.max(0, Math.ceil(Math.min(a.y, b.y, c.y) - 0.5));
                const maxY = Math.min(rows - 1, Math.floor(Math.max(a.y, b.y, c.y) - 0.5));
                if (minX > maxX || minY > maxY) return;
                const bx = acy / det,
                    by = -acx / det,
                    cx = -aby / det,
                    cy = abx / det;
                const dbw = b.iw - a.iw,
                    dcw = c.iw - a.iw;
                const dbu = b.u - a.u,
                    dcu = c.u - a.u,
                    dbv = b.v - a.v,
                    dcv = c.v - a.v;
                const wx = bx * dbw + cx * dcw,
                    wy = by * dbw + cy * dcw;
                const ux = bx * dbu + cx * dcu,
                    uy = by * dbu + cy * dcu;
                const vx = bx * dbv + cx * dcv,
                    vy = by * dbv + cy * dcv;
                for (let j = minY; j <= maxY; j++) {
                    for (let i = minX; i <= maxX; i++) {
                        const rb = bx * (i + 0.5 - a.x) + by * (j + 0.5 - a.y);
                        const rc = cx * (i + 0.5 - a.x) + cy * (j + 0.5 - a.y);
                        if (rb < 0 || rc < 0 || rb + rc > 1) continue;
                        const iw = a.iw + rb * dbw + rc * dcw,
                            index = j * cols + i;
                        if (iw <= depths[index]) continue;
                        const u = (a.u + rb * dbu + rc * dcu) / iw;
                        const v = (a.v + rb * dbv + rc * dcv) / iw;
                        const footprint = pixelFootprint(
                            ((ux - u * wx) * cols) / width,
                            ((vx - v * wx) * cols) / width,
                            ((uy - u * wy) * rows) / height,
                            ((vy - v * wy) * rows) / height,
                            anisotropy
                        );
                        const texelsPerPixel = (PAGE_SIZE * footprint) / iw;
                        const z = Math.max(
                            0,
                            Math.min(
                                MAX_IMAGE_LEVEL,
                                tk.level + Math.ceil(-Math.log2(texelsPerPixel))
                            )
                        );
                        depths[index] = iw;
                        samples[index] = {
                            ndcX: (2 * (i + 0.5)) / cols - 1,
                            ndcY: 1 - (2 * (j + 0.5)) / rows,
                            depth: 1 / iw,
                            tile,
                            z,
                            u: Math.max(0, Math.min(0.99999999, u)),
                            v: Math.max(0, Math.min(0.99999999, v))
                        };
                    }
                }
            }
            function triangle(ia, ib, ic) {
                if (projected[ia] && projected[ib] && projected[ic]) {
                    draw(projected[ia], projected[ib], projected[ic]);
                    return;
                }
                if (!projected[ia] && !projected[ib] && !projected[ic]) return;
                const polygon = [];
                let a = points[ic];
                for (const i of [ia, ib, ic]) {
                    const b = points[i];
                    if (a.w >= near !== b.w >= near) {
                        const t = (near - a.w) / (b.w - a.w);
                        polygon.push(
                            project({
                                x: a.x + t * (b.x - a.x),
                                y: a.y + t * (b.y - a.y),
                                w: near,
                                u: a.u + t * (b.u - a.u),
                                v: a.v + t * (b.v - a.v)
                            })
                        );
                    }
                    if (projected[i]) polygon.push(projected[i]);
                    a = b;
                }
                for (let i = 2; i < polygon.length; i++)
                    draw(polygon[0], polygon[i - 1], polygon[i]);
            }
            const n = shape.segments + 1;
            for (let y = 0; y + 1 < n; y++) {
                for (let x = 0; x + 1 < n; x++) {
                    const a = y * n + x;
                    triangle(a, a + 1, a + n);
                    triangle(a + 1, a + n + 1, a + n);
                }
            }
        }
        return samples.filter(Boolean);
    };
}

/** Rank each candidate by the remaining zoom-level deficit it removes across
 * visible samples. Caps bound network, texture residency and per-draw samplers.
 */
function selectPages(samples, perTile, total, previous = new Set(), resident) {
    const tiles = new Map(),
        candidates = new Map();
    const levels = samples.map(s => s.tile.tileKey.level),
        memberships = new Array(samples.length);
    samples.forEach((sample, i) => {
        const { tile, z, u, v } = sample;
        const tk = tile.tileKey;
        sample.mx = (tk.column + u) / 2 ** tk.level;
        sample.my = (tk.row + v) / 2 ** tk.level;
        if (!tiles.has(tile)) tiles.set(tile, { samples: 0, demand: 0, pages: [] });
        const stats = tiles.get(tile);
        stats.samples++;
        stats.demand = Math.max(stats.demand, z);
        if (!perTile || !total) return;
        const chain = (memberships[i] = []);
        // Finer than this ratio the local UV transform loses texel precision
        // on a transient, continent-scale ancestor. Let its children take over.
        for (
            let level = tk.level + 1;
            level <= Math.min(z + (resident ? 2 : 0), MAX_IMAGE_LEVEL, tk.level + 10);
            level++
        ) {
            const scale = 2 ** (level - tk.level);
            const x = tk.column * scale + Math.floor(u * scale);
            const y = tk.row * scale + Math.floor(v * scale);
            const width = 2 ** level,
                id = width * width + y * width + x;
            let candidate = candidates.get(id);
            if (candidate === undefined) {
                const k = key(level, x, y);
                candidate =
                    !resident || resident.has(k)
                        ? { tile, z: level, x, y, key: k, indices: [], gain: 0 }
                        : null;
                candidates.set(id, candidate);
            }
            if (candidate) {
                candidate.indices.push(i);
                candidate.gain += Math.max(0, Math.min(level, z) - tk.level);
                chain.push(candidate);
            }
        }
    });
    const selected = new Map();
    while (selected.size < total) {
        let best,
            highest = 0;
        for (const c of candidates.values()) {
            if (!c || tiles.get(c.tile).pages.length >= perTile) continue;
            // Prefer an already selected page across minor camera changes.
            const score = c.gain * (previous.has(c.key) ? 1.15 : 1);
            if (score > highest) {
                best = c;
                highest = score;
            }
        }
        if (!best) break;
        const page = { z: best.z, x: best.x, y: best.y, key: best.key, score: highest };
        selected.set(page.key, page);
        tiles.get(best.tile).pages.push(page);
        for (const i of best.indices) {
            const old = levels[i];
            if (old >= best.z) continue;
            levels[i] = best.z;
            // Only pages sharing this sample lose any remaining coverage gain.
            for (const c of memberships[i]) {
                const target = Math.min(c.z, samples[i].z);
                if (target > old) c.gain -= Math.min(target, best.z) - old;
            }
        }
    }
    return { tiles, selected };
}

// A coarser mesh can inherit more already-visible photos than its material
// can draw. Spend those slots on the visible pixels that would lose the most
// detail, accounting for overlap and the outgoing opacity of each photo.
function carriedPages(pages, tile, samples, limit, rank) {
    if (pages.length <= limit) return pages;
    const scale = 2 ** tile.z;
    const visible = [];
    for (const p of samples || []) {
        if (Math.floor(p.mx * scale) === tile.x && Math.floor(p.my * scale) === tile.y)
            visible.push({ mx: p.mx, my: p.my, demand: p.z, level: tile.z });
    }
    if (!visible.length) return pages.sort((a, b) => rank(b) - rank(a)).slice(0, limit);
    const choices = pages.map(page => {
        const { z, x, y } = page.entry;
        const width = 2 ** z;
        const points = visible.filter(p => Math.floor(p.mx * width) === x && Math.floor(p.my * width) === y);
        return { page, points, tie: Math.min(1, rank(page)) * 0.05 };
    });
    const selected = [];
    while (selected.length < limit && choices.length) {
        let best = 0, highest = -1;
        for (let i = 0; i < choices.length; i++) {
            const { page, points, tie } = choices[i];
            let gain = tie;
            for (const p of points)
                gain += page.alpha * Math.max(0, Math.min(page.entry.z, p.demand) - p.level);
            if (gain > highest) {
                best = i;
                highest = gain;
            }
        }
        const { page, points } = choices.splice(best, 1)[0];
        selected.push(page);
        for (const p of points)
            p.level += page.alpha * Math.max(0, Math.min(page.entry.z, p.demand) - p.level);
    }
    return selected;
}

// A complete raster page can cover many meshes. Keep that parent available
// for peripheral meshes while independently choosing deeper branches with
// high visible area. A strict quadtree cut pays for every sibling at each
// split and can leave a city-sized hole when just a few pages fit.
function baseId(tileKey, level) {
    const width = 2 ** level,
        scale = 2 ** (tileKey.level - level);
    return (
        width * width + Math.floor(tileKey.row / scale) * width + Math.floor(tileKey.column / scale)
    );
}
function selectBase(tiles, coverage, limit, previous) {
    const retained = new Set();
    for (const [tile, level] of previous || []) retained.add(baseId(tile.tileKey, level));
    const candidates = new Map(),
        rows = [];
    for (const tile of tiles) {
        const tk = tile.tileKey,
            coverageRow = coverage.get(tile);
        const target = coverageRow
            ? Math.min(tk.level, coverageRow.demand)
            : Math.max(0, tk.level - 2);
        const row = { tile, weight: coverageRow?.samples || 0.125, level: 0, ancestors: [] };
        rows.push(row);
        for (let z = 1; z <= target; z++) {
            const id = baseId(tk, z);
            let page = candidates.get(id);
            if (!page) {
                page = { id, z, gain: 0, rows: [], retention: retained.has(id) ? 1.08 : 1 };
                candidates.set(id, page);
            }
            page.rows.push(row);
            row.ancestors.push(page);
            page.gain += row.weight * z;
        }
    }
    const selected = new Set();
    // The root page always covers an unsampled tile and costs one slot.
    for (let slot = 1; slot < limit; slot++) {
        let best,
            highest = 0;
        for (const page of candidates.values()) {
            const score = page.gain * page.retention;
            if (score > highest) {
                best = page;
                highest = score;
            }
        }
        if (!best) break;
        selected.add(best.id);
        for (const row of best.rows) {
            const old = row.level;
            if (old >= best.z) continue;
            row.level = best.z;
            // Only ancestors overlapping a newly improved mesh lose benefit.
            for (const page of row.ancestors) {
                const advance = Math.min(page.z, best.z) - old;
                if (advance > 0) page.gain -= row.weight * advance;
            }
        }
    }
    const result = new Map();
    for (const row of rows) {
        const tk = row.tile.tileKey;
        // A sharper shared page may already cover this whole mesh without
        // spending another slot, even when this mesh requested a lower level.
        for (let z = tk.level; z > row.level; z--)
            if (selected.has(baseId(tk, z))) {
                row.level = z;
                break;
            }
        result.set(row.tile, row.level);
    }
    return result;
}

module.exports = { createCoverage, selectPages, selectBase, carriedPages, pixelFootprint };
