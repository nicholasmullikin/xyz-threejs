const { triangleHeight, R } = require("./math");
function createElevation(THREE, map) {
    let groundTiles = [];
    const groundCache = new Map();
    let lastGroundSample = null;
    function terrainHeight(geo) {
        const mx = (geo.longitude + 180) / 360,
            my =
                (1 - Math.log(Math.tan(Math.PI / 4 + (geo.latitude * Math.PI) / 360)) / Math.PI) /
                2;
        let surface = 0,
            sampled = false;
        for (const t of groundTiles) {
            const n = 2 ** t.tileKey.level,
                x = mx * n - t.tileKey.column,
                y = my * n - t.tileKey.row;
            if (x < 0 || x > 1 || y < 0 || y > 1) continue;
            const obj = t.objects.find(o => o.isMesh);
            if (!obj) continue;
            const p = obj.geometry.attributes.position,
                w = Math.sqrt(p.count);
            if (!Number.isInteger(w)) continue;
            const fx = x * (w - 1),
                fy = y * (w - 1),
                ix = Math.min(w - 2, Math.floor(fx)),
                iy = Math.min(w - 2, Math.floor(fy));
            const m = t.boundingBox.getRotationMatrix().clone().setPosition(t.center),
                v = new THREE.Vector3();
            const h = (xx, yy) =>
                v
                    .fromBufferAttribute(p, yy * w + xx)
                    .applyMatrix4(m)
                    .length() - R;
            const a = fx - ix,
                b = fy - iy;
            // Match the mesh's actual triangle diagonal, not a bilinear patch.
            surface = triangleHeight(
                h(ix, iy),
                h(ix + 1, iy),
                h(ix, iy + 1),
                h(ix + 1, iy + 1),
                a,
                b
            );
            sampled = true;
            break;
        }
        if (sampled)
            lastGroundSample = {
                latitude: geo.latitude,
                longitude: geo.longitude,
                height: surface
            };
        else if (lastGroundSample) {
            const distance =
                Math.hypot(
                    geo.latitude - lastGroundSample.latitude,
                    (geo.longitude - lastGroundSample.longitude) *
                        Math.cos((geo.latitude * Math.PI) / 180)
                ) * 111320;
            if (distance < 5000) surface = lastGroundSample.height;
        }
        return surface;
    }
    const terrainPicker = new THREE.Raycaster();
    const pickMesh = new THREE.Mesh();
    const elevationProvider = {
        getTilingScheme: () => require("@xyzmaps/harp-geoutils").webMercatorTilingScheme,
        clearCache() {
            groundTiles = [];
            groundCache.clear();
            lastGroundSample = null;
        },
        getHeight: terrainHeight,
        getDisplacementMap: () => undefined,
        rayCast(x, y) {
            const rect = map.canvas.getBoundingClientRect();
            terrainPicker.setFromCamera(
                new THREE.Vector2((x / rect.width) * 2 - 1, 1 - (y / rect.height) * 2),
                map.camera
            );
            const hits = [];
            for (const tile of groundTiles) {
                const mesh = tile.objects.find(o => o.isMesh);
                if (!mesh) continue;
                pickMesh.geometry = mesh.geometry;
                pickMesh.material = mesh.material;
                pickMesh.matrixWorld
                    .copy(tile.boundingBox.getRotationMatrix())
                    .setPosition(tile.center);
                pickMesh.raycast(terrainPicker, hits);
            }
            hits.sort((a, b) => a.distance - b.distance);
            return hits[0]?.point;
        }
    };
    function protectCamera() {
        const cam = map.camera,
            alt = cam.position.length() - R;
        if (alt > 15000) return;
        const surface = terrainHeight(map.projection.unprojectPoint(cam.position));
        if (alt < surface + 40) {
            cam.position.setLength(R + surface + 40);
            cam.updateMatrixWorld(true);
        }
    }

    return {
        terrainHeight,
        protectCamera,
        elevationProvider,
        update(entry) {
            for (const tile of entry.renderedTiles.values()) {
                const k = tile.tileKey.mortonCode();
                groundCache.delete(k);
                groundCache.set(k, tile);
            }
            while (groundCache.size > 256) groundCache.delete(groundCache.keys().next().value);
            groundTiles = [...groundCache.values()].sort(
                (a, b) => b.tileKey.level - a.tileKey.level
            );
        },
        dispose() {
            groundTiles = [];
            groundCache.clear();
            lastGroundSample = null;
        }
    };
}
module.exports = { createElevation };
