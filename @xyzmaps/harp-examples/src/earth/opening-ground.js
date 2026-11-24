// At street scale a continental height sample can move the apparent ground by
// hundreds of pixels. Present the local draw surface once its first blend settles.
const { webMercatorTilingScheme } = require("@xyzmaps/harp-geoutils");
function revealGround(map, terrain, pose) {
    const canvas = map.canvas;
    const eye = map.projection.unprojectPoint(map.camera.position);
    const { latitude, longitude } = pose.target;
    const radius = pose.distance * 0.45 / 111320;
    const center = webMercatorTilingScheme.getTileKey(pose.target, 17);
    const keys = new Map();
    for (const geo of [eye, pose.target, ...[[-1,0],[1,0],[0,-1],[0,1]].map(([x,y]) => ({
        latitude: Math.max(-85, Math.min(85, latitude + y * radius)),
        longitude: ((longitude + x * radius / Math.cos(latitude * Math.PI / 180) + 540) % 360) - 180
    }))]) {
        const key = webMercatorTilingScheme.getTileKey(geo, 15);
        if (key) keys.set(key.mortonCode(), key);
    }
    terrain.openingTiles = Array.from(keys.values());
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    status.textContent = "Loading local terrain…";
    status.style.cssText = "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#bdd1df;font:14px system-ui;pointer-events:none";
    canvas.parentElement.appendChild(status);
    const timer = setTimeout(reveal, 2800);
    let stableSince, lastCheck = -Infinity;
    function reveal() {
        clearTimeout(timer);
        terrain.openingTiles = undefined;
        map.removeEventListener("didrender", check);
        map.removeEventListener("dispose", reveal);
        for (const event of ["pointerdown", "wheel", "keydown"]) window.removeEventListener(event, reveal, true);
        status.remove();
        canvas.style.transition = matchMedia("(prefers-reduced-motion: reduce)").matches ? "" : "opacity 160ms ease-out";
        canvas.style.opacity = "1";
    }
    function check() {
        const now = performance.now();
        if (now - lastCheck < 50) return;
        lastCheck = now;
        const tiles = map.visibleTileSet.dataSourceTileList.find(e => e.dataSource === terrain)?.renderedTiles;
        if (!tiles?.size) return;
        const ready = new Set();
        let refining = false;
        let centerLevel = -1;
        let wanted = 15;
        while (center && wanted < 17 && terrain.shouldSubdivide(
            terrain.getDataZoomLevel(map.zoomLevel), center.changedLevelBy(wanted - 17)
        )) wanted++;
        for (const tile of tiles.values()) {
            const key = tile.tileKey;
            if (key.level < 15) continue;
            const id = key.changedLevelBy(15 - key.level).mortonCode();
            if (!keys.has(id)) continue;
            const mesh = tile.objects[0];
            if (!mesh || (mesh.geometry.userData.attributeMetadata?.position?.terrainSourceLevel ?? key.level) < 15) continue;
            if (center && key.level <= 17 && key.mortonCode() === center.changedLevelBy(key.level - 17).mortonCode()) {
                centerLevel = mesh.geometry.userData.attributeMetadata?.position?.terrainSourceLevel ?? key.level;
            }
            ready.add(id);
            if (Math.abs(mesh.material.uniforms?.terrainSourceScale?.value || 0) > 0.25) refining = true;
        }
        if (refining || ready.size !== keys.size || centerLevel < wanted) stableSince = undefined;
        else if (stableSince === undefined) stableSince = now;
        else if (now - stableSince >= (wanted === 15 ? 400 : 160)) reveal();
    }
    map.addEventListener("didrender", check);
    map.addEventListener("dispose", reveal);
    for (const event of ["pointerdown", "wheel", "keydown"]) window.addEventListener(event, reveal, { capture: true, passive: true });
}
module.exports = { revealGround };
