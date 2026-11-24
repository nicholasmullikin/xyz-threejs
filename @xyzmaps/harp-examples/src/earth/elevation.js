const { terrainTopology, samplePosition } = require("./terrain-sample");
const { createTerrainPicker } = require("./terrain-picking");
const { gridWidth } = require("./terrain-grid");
const { R } = require("./math");
function createElevation(THREE, map) {
    const groundCache = new Map(),
        watchedRegions = new Map();
    const vector = new THREE.Vector3();
    let survey,collision,
        lastGroundSample = null,
        epoch = 0,
        maxLevel = 0;
    // Each level occupies a disjoint integer range in the bounded DEM pyramid.
    const key = (n, x, y) => n * n + y * n + x;
    let geometryRevision = 0;
    function invalidate(record) {
        geometryRevision++;
        for (const region of watchedRegions.values()) {
            if (region.version === epoch) continue;
            if (
                ((record.left <= region.right && record.right >= region.left) ||
                    (record.left === 0 && region.right === 1) ||
                    (record.right === 1 && region.left === 0)) &&
                record.top <= region.bottom &&
                record.bottom >= region.top
            )
                region.version = epoch;
        }
    }
    const visibleRecords = [];
    let renderFrame = 0;
    function sampledHeight(record, u, v) {
        samplePosition(record, u, v, vector);
        return vector.applyMatrix4(record.matrix).length() - R;
    }
    let lastRecord;
    function heightAtMercator(mx, my) {
        mx -= Math.floor(mx);
        if (
            lastRecord?.lastVisible === renderFrame &&
            !lastRecord.tile.disposed &&
            mx >= lastRecord.left &&
            mx < lastRecord.right &&
            my >= lastRecord.top &&
            my < lastRecord.bottom
        ) {
            const n = 2 ** lastRecord.tile.tileKey.level;
            return sampledHeight(lastRecord, (mx - lastRecord.left) * n, (my - lastRecord.top) * n);
        }
        let sample, fallback, u, v, fallbackU, fallbackV;
        for (let level = maxLevel; level >= 0 && !sample; level--) {
            const n = 2 ** level,
                x = mx * n,
                y = my * n,
                col = Math.floor(x),
                row = Math.floor(y);
            for (let ty = row; ty >= row - Number(y === row) && !sample; ty--) {
                if (ty < 0 || ty >= n) continue;
                for (let tx = col; tx >= col - Number(x === col); tx--) {
                    const record = groundCache.get(key(n, tx < 0 ? n - 1 : tx, ty));
                    if (!record || record.tile.disposed) continue;
                    if (record.lastVisible === renderFrame) {
                        sample = record;
                        u = x - tx;
                        v = y - ty;
                        break;
                    }
                    if (!fallback) {
                        fallback = record;
                        fallbackU = x - tx;
                        fallbackV = y - ty;
                    }
                }
            }
        }
        // A cached finer tile outside the current draw cut is still useful
        // offscreen. Onscreen foundations and input follow the displayed mesh.
        if (sample) {
            lastRecord = sample;
            return sampledHeight(sample, u, v);
        }
        return fallback ? sampledHeight(fallback, fallbackU, fallbackV) : undefined;
    }
    function terrainHeight(geo, cameraFallback = false) {
        if (!Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) return 0;
        const sampled = surfaceHeightAt(
            (geo.longitude + 180) / 360,
            (1 - Math.asinh(Math.tan((geo.latitude * Math.PI) / 180)) / Math.PI) / 2
        );
        let surface = sampled ?? 0;
        if (sampled !== undefined && cameraFallback === true)
            lastGroundSample = {
                latitude: geo.latitude,
                longitude: geo.longitude,
                height: surface
            };
        else if (sampled === undefined && cameraFallback === true && lastGroundSample) {
            const distance =
                Math.hypot(
                    geo.latitude - lastGroundSample.latitude,
                    (((geo.longitude - lastGroundSample.longitude + 540) % 360) - 180) *
                        Math.cos((geo.latitude * Math.PI) / 180)
                ) * 111320;
            if (distance < 5000) surface = lastGroundSample.height;
        }
        return surface;
    }
    function surfaceHeightAt(x,y){return survey?.groundAt(x,y)??heightAtMercator(x,y);}
    terrainHeight.atMercator=(x,y)=>surfaceHeightAt(x,y)??0;
    terrainHeight.nativeAtMercator=(x,y)=>heightAtMercator(x,y)??0;
    terrainHeight.revisionForTile = (x, y, level) => {
        const n = 2 ** level,
            id = key(n, x, y);
        let region = watchedRegions.get(id);
        if (!region) {
            region = {
                left: x / n,
                right: (x + 1) / n,
                top: y / n,
                bottom: (y + 1) / n,
                version: ++epoch
            };
            if (watchedRegions.size >= 256)
                watchedRegions.delete(watchedRegions.keys().next().value);
        } else watchedRegions.delete(id);
        watchedRegions.set(id, region);
        const measured=survey?.regionRevision(x,y,level);
        if(region.measured!==measured){
            region.measured=measured;
            region.version=++epoch;
        }
        return region.version;
    };
    function clearCache() {
        groundCache.clear();
        lastRecord = undefined;
        visibleRecords.length = 0;
        watchedRegions.clear();
        lastGroundSample = null;
        collision = undefined;
        maxLevel = 0;
    }
    const terrainPicker = new THREE.Raycaster();
    const pickVisible = createTerrainPicker(THREE);
    const centerRay = new THREE.Ray(), lastOrigin = new THREE.Vector3(), lastDirection = new THREE.Vector3();
    let centerRevision=-1, surveyRevision, lastTarget;
    function pickRendered(ray){
        const native=pickVisible(ray,visibleRecords),measured=survey?.pick(ray);
        if(!measured)return native;
        if(!native||measured.distanceToSquared(ray.origin)<native.distanceToSquared(ray.origin))return measured;
        const geo=map.projection.unprojectPoint(native);
        const x=(geo.longitude+180)/360,y=(1-Math.asinh(Math.tan(geo.latitude*Math.PI/180))/Math.PI)/2;
        return survey.groundAt(x,y)===undefined?native:measured;
    }
    const elevationProvider = {
        getCameraTarget(camera) {
            if (!visibleRecords.length || camera.position.length() - R > 100000) return;
            centerRay.origin.copy(camera.position);
            camera.getWorldDirection(centerRay.direction);
            if (centerRevision !== geometryRevision || surveyRevision!==survey?.groundRevision || !lastOrigin.equals(centerRay.origin) || !lastDirection.equals(centerRay.direction)) {
                lastOrigin.copy(centerRay.origin);
                lastDirection.copy(centerRay.direction);
                centerRevision=geometryRevision;
                surveyRevision=survey?.groundRevision;
                lastTarget=pickRendered(centerRay);
            }
            return lastTarget?.clone();
        },
        getTilingScheme: () => require("@xyzmaps/harp-geoutils").webMercatorTilingScheme,
        clearCache,
        getHeight: terrainHeight,
        getDisplacementMap: () => undefined,
        rayCast(x, y) {
            const rect = map.canvas.getBoundingClientRect();
            terrainPicker.setFromCamera(
                new THREE.Vector2((x / rect.width) * 2 - 1, 1 - (y / rect.height) * 2),
                map.camera
            );
            return pickRendered(terrainPicker.ray);
        }
    };
    function protectCamera(now = performance.now()) {
        const cam = map.camera,
            altitude = cam.position.length() - R;
        // A navigation input owns the new pose. Only undo a displacement that
        // this guard itself made on an otherwise stationary camera.
        if (collision && cam.position.distanceToSquared(collision.applied) > 1e-8)
            collision = undefined;
        if (altitude > 15000) return;
        const surface = terrainHeight(map.projection.unprojectPoint(cam.position), true);
        const requested = collision?.requested ?? altitude;
        const safe = Math.max(requested, surface + 40);
        if (!collision && safe <= altitude) return;
        if (collision && Math.abs(safe - altitude) < 1e-6) {
            collision.time = now;
            if (safe === requested) collision = undefined;
            return;
        }
        if (!collision) collision = { requested, applied: cam.position.clone(), time: now };
        const easing = 1 - Math.exp(-Math.min(100, Math.max(1, now - collision.time)) / 110);
        const height = safe < altitude - 0.03 ? altitude + (safe - altitude) * easing : safe;
        cam.position.setLength(R + height);
        cam.updateMatrixWorld(true);
        collision.applied.copy(cam.position);
        collision.time = now;
        if (height === requested) collision = undefined;
        else if (height !== safe) map.update();
    }

    return {
        setSurvey(value){survey=value;},
        terrainHeight,
        protectCamera,
        elevationProvider,
        update(entry) {
            epoch++;
            renderFrame++;
            if (visibleRecords.length !== entry.renderedTiles.size) geometryRevision++;
            visibleRecords.length = 0;
            for (const tile of entry.renderedTiles.values()) {
                const { level, column, row } = tile.tileKey,
                    n = 2 ** level,
                    id = key(n, column, row);
                const mesh = tile.objects.find(o => o.isMesh);
                const position = mesh?.geometry.attributes.position;
                let record = groundCache.get(id);
                if (record) groundCache.delete(id);
                if (!position || tile.disposed) {
                    if (record) invalidate(record);
                    continue;
                }
                if (
                    !record ||
                    record.tile !== tile ||
                    record.mesh !== mesh ||
                    record.position !== position
                ) {
                    const width = gridWidth(mesh.geometry);
                    if (!Number.isInteger(width) || width < 2) {
                        if (record) invalidate(record);
                        continue;
                    }
                    record = {
                        tile,
                        mesh,
                        position,
                        width,
                        version: position.version,
                        topology: terrainTopology(mesh.geometry),
                        diagonal: mesh.geometry.userData?.attributeMetadata?.position?.terrainDiagonal,
                        positions: position.array,
                        matrix: tile.boundingBox.getRotationMatrix().setPosition(tile.center),
                        left: column / n,
                        right: (column + 1) / n,
                        top: row / n,
                        bottom: (row + 1) / n
                    };
                    invalidate(record);
                } else if (record.version !== position.version) {
                    record.version = position.version;
                    invalidate(record);
                }
                const morph = mesh.geometry.userData?.terrainTransition;
                const morphFactor = morph?.factor ?? 0;
                if (record.morphFactor !== morphFactor) {
                    record.morph = morph;
                    record.morphFactor = morphFactor;
                    invalidate(record);
                }
                if (record.lastVisible !== renderFrame - 1) invalidate(record);
                record.lastVisible = renderFrame;
                visibleRecords.push(record);
                groundCache.set(id, record);
                maxLevel = Math.max(maxLevel, level);
            }
            // Tile disposal can occur outside this frame's visible set.
            for (const [id, record] of groundCache) {
                if (record.tile.disposed || groundCache.size > 256) {
                    invalidate(record);
                    groundCache.delete(id);
                }
            }
        },
        dispose: clearCache
    };
}
module.exports = { createElevation };
