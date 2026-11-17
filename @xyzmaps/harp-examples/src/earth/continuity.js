/* Terrain boundary constraints for the vendored harp demo. Apache-2.0. */

function create(THREE, dataSource) {
    const originals = new WeakMap();
    const skirts = new WeakMap();
    let previous = "";
    return function reconcile(entries) {
        const entry = entries.find(e => e.dataSource === dataSource);
        if (!entry) {
            previous = "";
            return;
        }
        const tiles = [];
        for (const tile of entry.renderedTiles.values()) {
            for (const mesh of tile.objects) {
                if (!mesh.isMesh) continue;
                const geometry = mesh.geometry,
                    position = geometry.attributes.position;
                const width = Math.sqrt(position.count);
                // Skirts are children, so they inherit the terrain's camera-relative transform.
                const existingSkirt = skirts.get(geometry);
                if (existingSkirt) existingSkirt.material = mesh.material;
                if (!Number.isInteger(width) || width < 2) continue;
                let original = originals.get(position);
                if (!original) {
                    original = position.array.slice();
                    originals.set(position, original);
                }
                const matrix = tile.localTangentSpace
                    ? tile.boundingBox.getRotationMatrix().clone()
                    : new THREE.Matrix4();
                matrix.setPosition(tile.center);
                tiles.push({
                    tile,
                    mesh,
                    geometry,
                    position,
                    original,
                    width,
                    matrix,
                    inverse: matrix.clone().invert(),
                    z: tile.tileKey.level,
                    x: tile.tileKey.column,
                    y: tile.tileKey.row
                });
            }
        }
        const signature = tiles
            .map(t => `${t.mesh.uuid}/${t.geometry.uuid}`)
            .sort()
            .join(";");
        if (signature === previous) return;
        previous = signature;
        if (!tiles.length) return;
        const maxLevel = Math.max(...tiles.map(t => t.z));
        const worldWidth = (tiles[0].width - 1) * 2 ** maxLevel;
        const nodes = new Map(),
            vertical = new Map(),
            horizontal = new Map();
        const vector = new THREE.Vector3();
        const key = (x, y) => `${x},${y}`;
        const addEdge = (map, axis, start, end, tile, indices) => {
            if (!map.has(axis)) map.set(axis, []);
            map.get(axis).push({ start, end, tile, indices });
        };
        for (const t of tiles) {
            // Always start from decoded geometry, never accumulate rounding or LOD edits.
            t.position.array.set(t.original);
            const n = t.width - 1,
                scale = 2 ** (maxLevel - t.z);
            t.nodes = new Map();
            const add = (col, row) => {
                const i = row * t.width + col;
                if (t.nodes.has(i)) return;
                const x = ((t.x * n + col) * scale) % worldWidth,
                    y = (t.y * n + row) * scale;
                const k = key(x, y);
                if (!nodes.has(k)) nodes.set(k, { x, y, refs: [], level: Infinity });
                const node = nodes.get(k);
                node.refs.push({ t, i });
                node.level = Math.min(node.level, t.z);
                t.nodes.set(i, node);
            };
            for (let i = 0; i <= n; i++) {
                add(i, 0);
                add(i, n);
                add(0, i);
                add(n, i);
            }
            const x0 = t.x * n * scale,
                x1 = (t.x + 1) * n * scale;
            const y0 = t.y * n * scale,
                y1 = (t.y + 1) * n * scale;
            addEdge(vertical, x0, y0, y1, t, i => i * t.width);
            addEdge(vertical, x1 % worldWidth, y0, y1, t, i => i * t.width + n);
            addEdge(horizontal, y0, x0, x1, t, i => i);
            addEdge(horizontal, y1, x0, x1, t, i => n * t.width + i);
        }
        // Integer tile-grid coordinates identify a corner once, including T junctions.
        // Constraints always point to a coarser level, so resolution is acyclic.
        for (const node of nodes.values()) {
            const candidates = [
                ...(vertical.get(node.x) || []).map(e => [e, node.y]),
                ...(horizontal.get(node.y) || []).flatMap(e =>
                    node.x === 0
                        ? [
                              [e, 0],
                              [e, worldWidth]
                          ]
                        : [[e, node.x]]
                )
            ]
                .filter(([e, p]) => e.tile.z < node.level && p >= e.start && p <= e.end)
                .sort((a, b) => a[0].tile.z - b[0].tile.z);
            if (candidates.length) {
                const [e, p] = candidates[0],
                    n = e.tile.width - 1;
                const u = ((p - e.start) / (e.end - e.start)) * n,
                    lo = Math.floor(u);
                node.constraint = [
                    e.tile.nodes.get(e.indices(lo)),
                    e.tile.nodes.get(e.indices(Math.min(lo + 1, n))),
                    u - lo
                ];
            }
        }
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
                    if (ref.t.z === node.level) {
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
        for (const node of nodes.values()) {
            const value = resolve(node, "world", ({ t, i }) =>
                vector.fromBufferAttribute(t.position, i).applyMatrix4(t.matrix)
            );
            for (const { t, i } of node.refs) {
                vector.copy(value).applyMatrix4(t.inverse);
                t.position.setXYZ(i, vector.x, vector.y, vector.z);
            }
        }
        for (const t of tiles) {
            t.position.needsUpdate = true;
            t.geometry.computeVertexNormals();
            t.geometry.computeBoundingSphere();
            t.geometry.computeBoundingBox();
        }
        // Resolve all normals before writing any, to avoid traversal-order bias.
        for (const node of nodes.values())
            resolve(node, "normal", ({ t, i }) =>
                vector
                    .fromBufferAttribute(t.geometry.attributes.normal, i)
                    .transformDirection(t.matrix)
            );
        for (const node of nodes.values())
            for (const { t, i } of node.refs) {
                // Rotation only (no translation); preserve the interpolated vector length.
                const rotation = new THREE.Matrix3().setFromMatrix4(t.inverse);
                vector.copy(node.normal).applyMatrix3(rotation);
                t.geometry.attributes.normal.setXYZ(i, vector.x, vector.y, vector.z);
                t.geometry.attributes.normal.needsUpdate = true;
            }
        // A short radial skirt covers subpixel cracks from Float32 roundoff and
        // T-junction rasterization. It is not used to hide mismatched elevations.
        for (const t of tiles) {
            let skirt = skirts.get(t.geometry);
            const n = t.width - 1;
            const perimeter = [];
            for (let i = 0; i < n; i++) perimeter.push(i);
            for (let i = 0; i < n; i++) perimeter.push(i * t.width + n);
            for (let i = n; i > 0; i--) perimeter.push(n * t.width + i);
            for (let i = n; i > 0; i--) perimeter.push(i * t.width);
            const count = perimeter.length;
            if (!skirt) {
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute(
                    "position",
                    new THREE.Float32BufferAttribute(new Float32Array(count * 6), 3)
                );
                geometry.setAttribute(
                    "normal",
                    new THREE.Float32BufferAttribute(new Float32Array(count * 6), 3)
                );
                geometry.setAttribute(
                    "uv",
                    new THREE.Float32BufferAttribute(new Float32Array(count * 4), 2)
                );
                const indices = [];
                for (let i = 0; i < count; i++) {
                    const j = (i + 1) % count,
                        a = i * 2,
                        b = j * 2,
                        c = a + 1,
                        d = b + 1;
                    // Both windings, using the parent's material and culling mode.
                    indices.push(a, b, c, b, d, c, c, b, a, c, d, b);
                }
                geometry.setIndex(indices);
                skirt = new THREE.Mesh(geometry, t.mesh.material);
                skirt.frustumCulled = false;
                t.mesh.add(skirt);
                skirts.set(t.geometry, skirt);
            }
            const attrs = skirt.geometry.attributes,
                uv = t.geometry.attributes.uv;
            for (let j = 0; j < count; j++) {
                const i = perimeter[j];
                vector.fromBufferAttribute(t.position, i);
                attrs.position.setXYZ(j * 2, vector.x, vector.y, vector.z);
                vector.applyMatrix4(t.matrix);
                vector.addScaledVector(vector.clone().normalize(), -10).applyMatrix4(t.inverse);
                attrs.position.setXYZ(j * 2 + 1, vector.x, vector.y, vector.z);
                vector.fromBufferAttribute(t.geometry.attributes.normal, i);
                for (let k = 0; k < 2; k++) {
                    attrs.normal.setXYZ(j * 2 + k, vector.x, vector.y, vector.z);
                    if (uv) attrs.uv.setXY(j * 2 + k, uv.getX(i), uv.getY(i));
                }
            }
            for (const attr of Object.values(attrs)) attr.needsUpdate = true;
        }
    };
}

module.exports = { create };
