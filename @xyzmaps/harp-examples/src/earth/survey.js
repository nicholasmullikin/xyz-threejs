const { surveyBudget, lidarEnterDistance, lidarExitDistance } = require("./survey-budget");
function createSurvey(
    THREE,
    map,
    sky,
    small,
    surfacePages,
    getHeight,
    getTerrainState,
    environment
) {
    const masked = new Set(),
        budget = surveyBudget(small || navigator.connection?.saveData);
    const lidarBudget = surveyBudget(true);
    let sourceAt, regionsPending;
    let lidarEnabled = !navigator.connection?.saveData,
        enabled = false,
        disposed = false,
        current,
        mesh,
        generation = 0;
    const stats = { source: "", credit: "", url: "", visible: 0, bytes: 0, pending: 0 };
    const lidar = {
        id: "usgs-lidar",
        title: "USGS 3DEP lidar",
        credit: "https://www.usgs.gov/3d-elevation-program"
    };
    let seenTiles = new WeakMap();
    function forget(event) {
        masked.delete(event.target);
    }
    function deactivate() {
        generation++;
        for (const material of masked) {
            material.stencilWrite = false;
            material.removeEventListener("dispose", forget);
        }
        seenTiles = new WeakMap();
        masked.clear();
        mesh?.dispose();
        mesh = undefined;
        current = undefined;
        Object.assign(stats, {
            source: "",
            credit: "",
            url: "",
            visible: 0,
            bytes: 0,
            pending: 0,
            transferred: 0,
            points: 0,
            dataset: "",
            lastError: "",
            photoPromotions: 0,
            photoSourceBytes: 0,
            photoExtraBytes: 0,
            photoBackupBytes: 0,
            fallbackMeshes: 0
        });
    }
    const up = new THREE.Vector3();
    return {
        stats,
        get groundRevision() {
            return mesh?.groundRevision;
        },
        regionRevision(x, y, level) {
            return mesh?.regionRevision?.(x, y, level);
        },
        lidarWeightAt(x, y) {
            return mesh?.lidarWeightAt?.(x, y);
        },
        groundAt(x, y) {
            return mesh?.groundAt?.(x, y);
        },
        pick(ray) {
            return mesh?.pick?.(ray);
        },
        roofSamples(tileKey) {
            return mesh?.roofSamples?.(tileKey);
        },
        setEnabled(value) {
            enabled = value;
            if (value && !sourceAt && !regionsPending) {
                regionsPending = import(
                    /* webpackChunkName:"earth-survey-regions" */ "./survey-region"
                )
                    .then(module => {
                        sourceAt = module.sourceAt;
                        map.update();
                    })
                    .catch(() => {})
                    .finally(() => {
                        regionsPending = undefined;
                    });
            }
            if (!value && current !== lidar) deactivate();
            map.update();
        },
        setLidarEnabled(value) {
            lidarEnabled = value;
            if (!value && current === lidar) deactivate();
            map.update();
        },
        update(mode, entries) {
            if ((!enabled && !lidarEnabled) || disposed) return;
            const { latitude, longitude } = map.target;
            const day = up
                .copy(map.camera.position)
                .normalize()
                .dot(sky.uniforms.sunDirection.value);
            let source;
            if (enabled && mode === "a" && map.zoomLevel > 12.4) {
                source = sourceAt?.(latitude, longitude);
                if (source?.continuous && day <= -0.075) source = undefined;
            }
            if (
                !source && lidarEnabled &&
                map.targetDistance < (current === lidar ? lidarExitDistance : lidarEnterDistance) &&
                latitude > 17 &&
                latitude < 73 &&
                longitude < -64 &&
                longitude > -173
            )
                source = lidar;
            if (source !== current) {
                deactivate();
                if (source) {
                    current = source;
                    const request = generation;
                    const module =
                        source === lidar
                            ? import(/* webpackChunkName:"earth-lidar-surface" */ "./lidar-surface")
                            : import(/* webpackChunkName:"earth-survey" */ "./survey-mesh.mjs");
                    module
                        .then(api => {
                            if (request !== generation || disposed) return;
                            mesh =
                                source === lidar
                                    ? api.createLidarSurface(
                                          THREE,
                                          map,
                                          source,
                                          small,
                                          stats,
                                          getTerrainState,
                                          getHeight,
                                          lidarBudget
                                      )
                                    : api.createSurveyMesh(
                                          THREE,
                                          map,
                                          source,
                                          small,
                                          stats,
                                          surfacePages,
                                          sky,
                                          environment,
                                          budget
                                      );
                            Object.assign(stats, {
                                source: source.id,
                                credit: source.title,
                                url: source.credit
                            });
                            map.update();
                        })
                        .catch(() => {
                            if (request === generation) stats.pending = 0;
                        });
                }
            }
            mesh?.update(day);
            if (mesh && stats.visible) {
                for (const entry of entries) {
                    const terrain = entry.dataSource.name === "terrain";
                    if (!terrain && entry.dataSource.name !== "buildings") continue;
                    for (const tile of entry.renderedTiles.values()) {
                        // Harp appends objects when geometry is created. The
                        // common stationary frame can skip all material work.
                        const old = seenTiles.get(tile),
                            objects = tile.objects;
                        if (
                            old &&
                            old.count === objects.length &&
                            old.last === objects[objects.length - 1] &&
                            old.first === objects[0]
                        )
                            continue;
                        seenTiles.set(tile, {
                            count: objects.length,
                            last: objects[objects.length - 1],
                            first: objects[0]
                        });
                        for (const object of objects) {
                            const material = object.material;
                            if (!material?.isMaterial || masked.has(material)) continue;
                            material.stencilWrite = true;
                            material.stencilRef = 0;
                            material.stencilFuncMask = terrain ? 96 : 64;
                            material.stencilWriteMask = 0;
                            material.stencilFunc = THREE.EqualStencilFunc;
                            material.addEventListener("dispose", forget);
                            masked.add(material);
                        }
                    }
                }
            }
        },
        dispose() {
            disposed = true;
            deactivate();
        }
    };
}
module.exports = { createSurvey };
