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
function create(THREE, map, sky, environment, getHeight) {
    const { BuildingsDataSource } = require("./building-data-source");
    const style = createStyle(THREE, map, sky, environment, getHeight);
    const source = new BuildingsDataSource(style);
    let enabled = true,
        disposed = false;
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
            const terrain = entries.find(e => e.dataSource.name === "terrain");
            const version = terrain
                ? [...terrain.renderedTiles.values()].map(t => t.tileKey.mortonCode()).join(",")
                : "";
            source.stats.tiles = 0;
            source.stats.buildings = 0;
            source.stats.cache = 0;
            source.stats.cacheBytes = 0;
            source.stats.visibleBytes = 0;
            map.forEachCachedTile(t => {
                if (t.dataSource === source) {
                    source.stats.cache++;
                    source.stats.cacheBytes += t.memoryUsage;
                    if (t.isVisible) source.stats.visibleBytes += t.memoryUsage;
                }
            });
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
                            style.update(tile, mesh.material, version);
                            source.stats.buildings +=
                                mesh.userData.feature?.objInfos?.[0]?.count || 0;
                        }
                }
        },
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
