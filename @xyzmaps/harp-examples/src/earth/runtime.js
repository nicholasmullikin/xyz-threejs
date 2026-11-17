const { create: createAtmosphere } = require("./atmosphere");
const { create: createEnvironment } = require("./environment");
const { create: createBuildings } = require("./buildings");
const { createElevation } = require("./elevation");
const { createImagery } = require("./imagery");
const { createControls } = require("./controls");
const { clipPlanes } = require("./math");
/** Coordinates source-owned subsystems. MapView owns tile geometry/material disposal. */
function create(THREE, map, source, token) {
    const sky = createAtmosphere(THREE, map),
        environment = createEnvironment(THREE, map, sky);
    const elevation = createElevation(THREE, map);
    const imagery = createImagery(THREE, map, source, token, sky, environment);
    const buildings = createBuildings(THREE, map, sky, environment, elevation.terrainHeight);
    let disposed = false,
        playing = false,
        mode = "a",
        sunHour = 14,
        lastTime = performance.now(),
        controls;
    const sun = sky.uniforms.sunDirection.value;
    function setSunHour(hour) {
        if (disposed) return;
        sunHour = hour;
        controls?.updateSun(hour);
        const lon = ((-112.15 + (12 - hour) * 15) * Math.PI) / 180,
            declination = (-19 * Math.PI) / 180;
        sun.set(
            Math.cos(declination) * Math.cos(lon),
            Math.cos(declination) * Math.sin(lon),
            Math.sin(declination)
        );
        map.update();
    }
    setSunHour(sunHour);
    map.beforeCameraUpdate = elevation.protectCamera;
    controls = createControls({
        map,
        setSunHour,
        environment,
        buildings,
        getSunHour: () => sunHour,
        togglePlaying() {
            playing = !playing;
            lastTime = performance.now();
            return playing;
        }
    });
    return {
        update(entries) {
            if (disposed) return;
            const now = performance.now();
            if (playing && !document.hidden)
                setSunHour((sunHour + Math.min(now - lastTime, 100) / 30000) % 24);
            lastTime = now;
            sky.update();
            environment.update(mode);
            const entry = entries.find(e => e.dataSource === source);
            if (entry) elevation.update(entry);
            buildings.update(entries, mode);
            imagery.update(entries);
            if (playing && !document.hidden) map.update();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            map.beforeCameraUpdate = undefined;
            map.setElevationProvider(undefined);
            controls.dispose();
            buildings.dispose();
            imagery.dispose();
            elevation.dispose();
            environment.dispose();
            sky.dispose();
        },
        createTileMaterial: imagery.createTileMaterial,
        stats: imagery.stats,
        buildings,
        environment,
        elevationProvider: elevation.elevationProvider,
        protectCamera: elevation.protectCamera,
        setSunHour,
        setMode(value) {
            mode = value;
            imagery.setMode(value);
        },
        setContours: imagery.setContours,
        setHillshade: imagery.setHillshade,
        get sun() {
            return sun;
        },
        get cacheSize() {
            return imagery.cacheSize;
        },
        get pendingCount() {
            return imagery.pendingCount;
        }
    };
}
module.exports = { create, clipPlanes };
