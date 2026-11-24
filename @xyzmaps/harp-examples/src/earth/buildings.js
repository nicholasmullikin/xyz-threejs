const { createStyle } = require("./building-material");
function coords(lat, lon) {
    const n = 2 ** 14;
    return [
        (((((lon + 180) / 360) * n) % n) + n) % n,
        ((1 -
            Math.log(
                Math.tan(Math.PI / 4 + (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 360)
            ) /
                Math.PI) /
            2) *
            n
    ];
}
function create(THREE, map, sky, environment, getHeight, getSurfacePages, survey) {
    const { BuildingsDataSource } = require("./building-data-source");
    const style = createStyle(THREE, map, sky, environment, getHeight, getSurfacePages, survey);
    const source = new BuildingsDataSource(style);
    let enabled = true,
        disposed = false,
        lastCacheSample = -Infinity;
    map.addDataSource(source).catch(() => {
        if (!disposed) source.stats.failures++;
    });
    return {
        source,
        stats: source.stats,
        update(entries, mode) {
            const wasEnabled = source.enabled;
            source.enabled =
                enabled &&
                mode === "a" &&
                map.zoomLevel > 12.4 &&
                map.camera.position.length() - 6378137 < 35000;
            if (wasEnabled !== source.enabled) map.update();
            source.stats.active = source.enabled;
            const entry = entries.find(e => e.dataSource === source);
            // Older elevation providers can still use the broad terrain signature.
            const terrain = getHeight.revisionForTile
                ? undefined
                : entries.find(e => e.dataSource.name === "terrain");
            const version = terrain
                ? [...terrain.renderedTiles.values()].map(t => t.tileKey.mortonCode()).join(",")
                : "";
            source.stats.tiles = 0;
            source.stats.shapedRoofs=0;
            source.stats.measuredBuildings=0;
            source.stats.buildings = 0;
            // Cache statistics are diagnostic; avoid walking all cached terrain and
            // building tiles on every rendered frame.
            const now = performance.now();
            if (now - lastCacheSample >= 1000) {
                lastCacheSample = now;
                source.stats.cache = 0;
                source.stats.cacheBytes = 0;
                source.stats.visibleBytes = 0;
                map.visibleTileSet.forEachCachedTile(t => {
                    source.stats.cache++;
                    source.stats.cacheBytes += t.memoryUsage;
                    if (t.isVisible) source.stats.visibleBytes += t.memoryUsage;
                }, source);
            }
            if (entry)
                for (const tile of entry.renderedTiles.values())
                    for (const mesh of tile.objects) mesh.visible = source.enabled;
            if (entry && source.enabled)
                for (const tile of entry.renderedTiles.values()) {
                    source.stats.tiles++;
                    for (const mesh of tile.objects)
                        if (mesh.isMesh) {
                            if (!mesh.geometry.boundingSphere)
                                mesh.geometry.computeBoundingSphere();
                            style.update(
                                tile,
                                mesh.material,
                                getHeight.revisionForTile
                                    ? getHeight.revisionForTile(
                                          tile.tileKey.column,
                                          tile.tileKey.row,
                                          tile.tileKey.level
                                      )
                                    : version,
                                mesh
                            );
                            source.stats.measuredBuildings+=mesh.geometry.userData?.measuredBuildings||0;
                            source.stats.shapedRoofs += mesh.userData.feature?.objInfos?.[0]?.shapedRoofs || 0;
                            source.stats.buildings +=
                                mesh.userData.feature?.objInfos?.[0]?.count || 0;
                        }
                }
        },
        setRoofShapes:value=>source.setRoofShapes(value),
        setEnabled(value) {
            enabled = value;
            map.update();
        },
        dispose() {
            disposed = true;
            source.enabled = false;
            map.removeDataSource(source);
            source.dispose();
        }
    };
}
module.exports = { create, coords };
