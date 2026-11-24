/* Terrain boundary constraints for the vendored harp demo. Apache-2.0. */

// Keep the border graph between frames. A joining or leaving tile invalidates its
// edges and any finer samples that interpolate those edges, including T junctions.
function createTopology(worldWidth) {
    const active = new Set(),
        nodes = new Map();
    const columns = new Map(),
        rows = new Map();
    function line(lines, coordinate) {
        if (!lines.has(coordinate)) lines.set(coordinate, { edges: new Set(), nodes: new Set() });
        return lines.get(coordinate);
    }
    function update(next) {
        const dirty = new Set(),
            edgesChanged = [];
        for (const t of active) {
            if (next.has(t)) continue;
            for (const ref of t.refs) {
                ref.node.refs.delete(ref);
                dirty.add(ref.node);
            }
            for (const edge of t.edges) {
                edge.line.edges.delete(edge);
                edgesChanged.push(edge);
            }
            t.refs = t.edges = t.nodes = undefined;
            active.delete(t);
        }
        for (const t of next) {
            if (active.has(t)) continue;
            active.add(t);
            const n = t.width - 1,
                scale = worldWidth / t.density;
            t.nodes = new Map();
            t.refs = t.perimeter.map((i, j) => {
                const logical = t.logicalPerimeter[j],
                    col = logical % t.width,
                    row = Math.floor(logical / t.width);
                const x = ((t.x * n + col) * scale) % worldWidth,
                    y = (t.y * n + row) * scale;
                const key = x + "," + y;
                let node = nodes.get(key);
                if (!node) {
                    node = { key, x, y, refs: new Set(), density: Infinity };
                    nodes.set(key, node);
                    line(columns, x).nodes.add(node);
                    line(rows, y).nodes.add(node);
                }
                const ref = { t, i, j, node };
                node.refs.add(ref);
                t.nodes.set(logical, node);
                dirty.add(node);
                return ref;
            });
            const x0 = t.x * n * scale,
                x1 = (t.x + 1) * n * scale;
            const y0 = t.y * n * scale,
                y1 = (t.y + 1) * n * scale;
            // Edges survive this update. Store integer layout, so each live edge
            // cannot retain the update frame and all its departed tiles.
            const edge = (vertical, at, start, end, offset, stride) => {
                const edgeLine = line(vertical ? columns : rows, at);
                const e = { vertical, line: edgeLine, start, end, tile: t, offset, stride };
                edgeLine.edges.add(e);
                edgesChanged.push(e);
                return e;
            };
            t.edges = [
                edge(true, x0, y0, y1, 0, t.width),
                edge(true, x1 % worldWidth, y0, y1, n, t.width),
                edge(false, y0, x0, x1, 0, 1),
                edge(false, y1, x0, x1, n * t.width, 1)
            ];
        }
        // A finer tile may have vertices inside this edge that were never
        // vertices of the arriving/departing tile itself.
        for (const edge of edgesChanged)
            for (const node of edge.line.nodes) {
                const at = edge.vertical ? node.y : node.x;
                if (
                    (at >= edge.start && at <= edge.end) ||
                    (!edge.vertical && at === 0 && edge.end === worldWidth)
                )
                    dirty.add(node);
            }
        for (const node of dirty) {
            if (node.constraint) {
                const [a, b] = node.constraint;
                a.dependents.delete(node);
                b.dependents.delete(node);
                node.constraint = undefined;
            }
            if (node.refs.size === 0) {
                nodes.delete(node.key);
                const col = columns.get(node.x),
                    row = rows.get(node.y);
                col.nodes.delete(node);
                row.nodes.delete(node);
                if (col.nodes.size === 0 && col.edges.size === 0) columns.delete(node.x);
                if (row.nodes.size === 0 && row.edges.size === 0) rows.delete(node.y);
                dirty.delete(node);
                continue;
            }
            node.density = Infinity;
            for (const { t } of node.refs) node.density = Math.min(node.density, t.density);
            let coarse, p;
            const consider = (edges, at) => {
                for (const e of edges) {
                    if (
                        e.tile.density >= node.density ||
                        (coarse && coarse.tile.density <= e.tile.density) ||
                        at < e.start ||
                        at > e.end
                    )
                        continue;
                    coarse = e;
                    p = at;
                }
            };
            consider(columns.get(node.x).edges, node.y);
            const horizontal = rows.get(node.y).edges;
            consider(horizontal, node.x);
            if (node.x === 0) consider(horizontal, worldWidth);
            if (coarse) {
                const n = coarse.tile.width - 1;
                const u = ((p - coarse.start) / (coarse.end - coarse.start)) * n;
                const lo = Math.floor(u);
                const a = coarse.tile.nodes.get(coarse.offset + lo * coarse.stride);
                const b = coarse.tile.nodes.get(
                    coarse.offset + Math.min(n, lo + 1) * coarse.stride
                );
                node.constraint = [a, b, u - lo];
                (a.dependents ??= new Set()).add(node);
                (b.dependents ??= new Set()).add(node);
            }
        }
        return dirty;
    }
    function clear() {
        for (const t of active) t.nodes = t.refs = t.edges = undefined;
        active.clear();
    }
    return { active, update, clear, worldWidth };
}

function invalidate(dirty, field) {
    // Set iteration visits entries appended during traversal.
    for (const node of dirty) {
        node[field] = undefined;
        if (node.dependents) for (const child of node.dependents) dirty.add(child);
    }
}

const { surfaceNormals, boundaryFaces, refreshBoundaryNormals } = require("./terrain-normals");
const { perimeterIndices, gridWidth, prepareTerrainGrid } = require("./terrain-grid");

function create(THREE, dataSource, transition) {
    const records = new WeakMap();
    let topology;
    return function reconcile(entries) {
        const entry = entries.find(e => e.dataSource === dataSource);
        if (!entry) {
            transition?.([], false);
            topology?.clear();
            topology = undefined;
            return;
        }
        const tiles = [];
        for (const tile of entry.renderedTiles.values()) {
            for (const mesh of tile.objects) {
                if (!mesh.isMesh) continue;
                const geometry = mesh.geometry;
                let position = geometry.attributes.position;
                let t = records.get(geometry);
                if (!t || t.mesh !== mesh || t.position !== position) {
                    const width =
                        geometry.userData?.attributeMetadata?.position?.terrainEdgeWidth ??
                        gridWidth(geometry);
                    if (!Number.isInteger(width) || width < 2) continue;
                    const matrix = tile.localTangentSpace
                        ? tile.boundingBox.getRotationMatrix().clone()
                        : new THREE.Matrix4();
                    matrix.setPosition(tile.center);
                    const n = width - 1;
                    const logicalPerimeter = perimeterIndices(width);
                    const surfaceCount =
                        geometry.userData?.attributeMetadata?.position?.terrainSurfaceCount;
                    const perimeter = surfaceCount
                        ? logicalPerimeter.map((_, j) => j)
                        : logicalPerimeter;
                    prepareTerrainGrid(THREE, geometry, width, perimeter);
                    position = geometry.attributes.position;
                    // Only border vertices are stitched. Keep their decoded world positions
                    // and raw surface normals so repeated exchanges never accumulate edits.
                    const original = new Float64Array(perimeter.length * 3);
                    const vector = new THREE.Vector3();
                    perimeter.forEach((idx, j) => {
                        vector
                            .fromBufferAttribute(position, idx)
                            .applyMatrix4(matrix)
                            .toArray(original, j * 3);
                    });
                    t = {
                        mesh,
                        tile,
                        geometry,
                        position,
                        width,
                        matrix,
                        original,
                        perimeter,
                        logicalPerimeter,
                        surfaceCount: surfaceCount ?? width * width,
                        surfaceNormals: new Float64Array(original.length),
                        inverse: matrix.clone().invert(),
                        inverseRotation: new THREE.Matrix3().setFromMatrix4(
                            matrix.clone().invert()
                        ),
                        z: tile.tileKey.level,
                        density: n * 2 ** tile.tileKey.level,
                        x: tile.tileKey.column,
                        y: tile.tileKey.row
                    };
                    records.set(geometry, t);
                }
                tiles.push(t);
            }
        }
        if (!tiles.length) {
            transition?.(tiles, false);
            topology?.clear();
            topology = undefined;
            return;
        }
        if (
            topology &&
            tiles.length === topology.active.size &&
            tiles.every(t => topology.active.has(t))
        ) {
            transition?.(tiles, true);
            return;
        }
        // Keep a common integer lattice for mixed resolutions and all quadtree levels.
        if (!topology || tiles.some(t => topology.worldWidth % t.density !== 0)) {
            const maxLevel = Math.max(...tiles.map(t => t.z));
            const worldWidth = Math.max(...tiles.map(t => t.width - 1)) * 2 ** maxLevel;
            topology?.clear();
            topology = createTopology(worldWidth);
        }
        for (const t of tiles) {
            t.seamChanged = false;
            t.surfaceChanged = !t.prepared;
            t.normalChanged = !t.prepared;
        }
        const dirty = topology.update(new Set(tiles));
        invalidate(dirty, "world");
        const vector = new THREE.Vector3();
        function resolve(node, field, read) {
            if (node[field]) return node[field];
            let value;
            if (node.constraint) {
                const [a, b, f] = node.constraint;
                value = resolve(a, field, read)
                    .clone()
                    .lerp(resolve(b, field, read), f);
            } else {
                value = new THREE.Vector3();
                let count = 0;
                for (const ref of node.refs)
                    if (ref.t.density === node.density) {
                        value.add(read(ref));
                        count++;
                    }
                value.multiplyScalar(1 / count);
            }
            // Do not normalize interpolated normals: the fine edge must interpolate
            // the same vectors as the coarse triangle, including their lengths.
            if (field === "normal" && !node.constraint) value.normalize();
            node[field] = value;
            return value;
        }
        const differs = (attribute, i, v) =>
            Math.fround(v.x) !== attribute.getX(i) ||
            Math.fround(v.y) !== attribute.getY(i) ||
            Math.fround(v.z) !== attribute.getZ(i);
        for (const node of dirty) {
            const value = resolve(node, "world", ({ t, j }) => vector.fromArray(t.original, 3 * j));
            for (const { t, i } of node.refs) {
                vector.copy(value).applyMatrix4(t.inverse);
                if (differs(t.position, i, vector)) {
                    t.position.setXYZ(i, vector.x, vector.y, vector.z);
                    t.seamChanged = t.surfaceChanged = true;
                }
            }
        }
        const dirtyNormals = new Set(dirty);
        for (const t of tiles) {
            if (!t.surfaceChanged) continue;
            t.position.needsUpdate = true;
            const index = t.geometry.index.array;
            const end = index.length - 12 * t.perimeter.length;
            let normal = t.geometry.attributes.normal;
            if (
                !t.prepared &&
                !t.geometry.userData.attributeMetadata?.position?.terrainSurfaceNormals
            ) {
                const values = surfaceNormals(
                    t.position.array,
                    index,
                    t.surfaceCount,
                    end,
                    normal?.array
                );
                if (!normal) {
                    normal = new THREE.BufferAttribute(values, 3);
                    t.geometry.setAttribute("normal", normal);
                }
            } else if (t.seamChanged) {
                t.normalPlan ??= boundaryFaces(index, t.surfaceCount, end, t.perimeter);
                refreshBoundaryNormals(t.position.array, index, normal.array, t.normalPlan);
            }
            t.normalChanged = true;
            t.perimeter.forEach((i, j) => {
                vector
                    .fromBufferAttribute(normal, i)
                    .transformDirection(t.matrix)
                    .toArray(t.surfaceNormals, j * 3);
                dirtyNormals.add(t.nodes.get(t.logicalPerimeter[j]));
            });
        }
        invalidate(dirtyNormals, "normal");
        for (const node of dirtyNormals) {
            const value = resolve(node, "normal", ({ t, j }) =>
                vector.fromArray(t.surfaceNormals, 3 * j)
            );
            for (const { t, i } of node.refs) {
                vector.copy(value).applyMatrix3(t.inverseRotation);
                const normal = t.geometry.attributes.normal;
                const changed = normal.normalized
                    ? Math.round(32767 * vector.x) !== normal.array[3 * i] ||
                      Math.round(32767 * vector.y) !== normal.array[3 * i + 1] ||
                      Math.round(32767 * vector.z) !== normal.array[3 * i + 2]
                    : differs(normal, i, vector);
                if (changed) {
                    normal.setXYZ(i, vector.x, vector.y, vector.z);
                    t.normalChanged = true;
                }
            }
        }
        // A short radial skirt covers subpixel cracks from Float32 roundoff and
        // T-junction rasterization. It is not used to hide mismatched elevations.
        for (const t of tiles) {
            if (!t.surfaceChanged && !t.normalChanged) continue;
            if (t.normalChanged) t.geometry.attributes.normal.needsUpdate = true;
            const normal = t.geometry.attributes.normal;
            const first = t.surfaceCount;
            for (let j = 0; j < t.perimeter.length; j++) {
                const i = t.perimeter[j],
                    top = first + 2 * j;
                if (t.surfaceChanged) {
                    vector.fromBufferAttribute(t.position, i);
                    t.position.setXYZ(top, vector.x, vector.y, vector.z);
                    vector.applyMatrix4(t.matrix);
                    vector.multiplyScalar(1 - 10 / (vector.length() || 1)).applyMatrix4(t.inverse);
                    t.position.setXYZ(top + 1, vector.x, vector.y, vector.z);
                }
                vector.fromBufferAttribute(normal, i);
                normal.setXYZ(top, vector.x, vector.y, vector.z);
                normal.setXYZ(top + 1, vector.x, vector.y, vector.z);
            }
            if (t.surfaceChanged) {
                // Terrain culls by its geographic tile bounds. The enclosing local
                // sphere also covers the skirts and costs no second vertex scan.
                t.geometry.computeBoundingBox();
                t.geometry.boundingBox.getBoundingSphere(t.geometry.boundingSphere ??= new THREE.Sphere());
            }
            t.prepared = true;
        }
        transition?.(tiles, false);
    };
}

module.exports = { create };
