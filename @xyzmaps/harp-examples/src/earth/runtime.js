const { create: createAtmosphere } = require("./atmosphere");
const { create: createEnvironment } = require("./environment");
const { create: createBuildings } = require("./buildings");
const { createElevation } = require("./elevation");
const { createImagery } = require("./imagery");
const { createControls } = require("./controls");
const { clipPlanes } = require("./math");
/** Coordinates source-owned subsystems. MapView owns tile geometry/material disposal. */
function create(THREE, map, source, token) {
    const profiler = require("./performance").createProfiler(map);
    const navigationQuality = require("./performance").createNavigationQuality(map, profiler);
    // The movement detector runs after tile preparation. Read the completed
    // frame here so a slow draw cannot expire the previous movement timer first.
    const observeNavigation = () => navigationQuality.observe(performance.now());
    map.addEventListener("didrender", observeNavigation);
    const params = new URLSearchParams(location.search);
    const budget = require("./device-budgets").deviceBudgets(globalThis.navigator);
    const requestedWater = params.get("reflection");
    const waterDebug = requestedWater === "mask";
    let waterModel = waterDebug ? "coastal" : requestedWater;
    if (requestedWater === "auto") {
        const caps = map.renderer.capabilities;
        const conserve = globalThis.navigator?.connection?.saveData ||
            require("./device-budgets").softwareRasterizer(map.renderer.getContext());
        waterModel = conserve || caps.maxTextures < 16 ? "shared" :
            !caps.isWebGL2 || budget.rasterMiB <= 48 || globalThis.matchMedia?.("(pointer: coarse)").matches ? "waves" : "coastal";
    }
    const orbitWater = ["waves","clouds","planar","coastal"].includes(waterModel) && map.renderer.capabilities.maxTextures >= 16;
    const sky = createAtmosphere(THREE, map, { surfaceFallback: true, orbitWater }),
        environment = createEnvironment(THREE, map, sky, { forecast: true });
    const cloudShadows = require("./cloud-shadow-cache").create(
        THREE,
        map,
        sky,
        environment,
        require("./atmosphere").glsl,
        require("./environment").glsl
    );
    const elevation = createElevation(THREE, map);
    const shadows = require("./local-shadows").createShadows(
        THREE,
        map,
        sky,
        elevation.terrainHeight,
        budget.rasterMiB <= 48
    );
    const water = require("./mapped-water").mappedWater(THREE, map,waterModel==="coastal");
    const lamps = require("./street-lights").streetLights(
        THREE,
        map,
        sky,
        environment,
        elevation.terrainHeight,
        budget.rasterMiB <= 48
    );
    const roads = require("./roads").createRoads(THREE, map, sky, environment);
    const cloudProbe = ["clouds","planar","coastal"].includes(waterModel) && map.renderer.capabilities.maxTextures >= 16
        ? require("./water-reflections").cloudProbe(THREE,map,sky,environment) : undefined;
    const planarProbe = ["planar","coastal"].includes(waterModel) && cloudProbe
        ? require("./water-planar").planarProbe(THREE,map,sky,water,elevation.terrainHeight,environment) : undefined;
    const windParam=params.get("wind");
    const windScale=windParam==="calm"?.06:windParam==="rough"?1:.45;
    const slopeGlint=params.get("glint")==="slopes" || (waterModel==="coastal" && params.get("glint")!=="ggx");
    const deepWater=waterModel==="coastal" && orbitWater
        ? require("./deep-water").createDeepWater(THREE,map,sky,environment,cloudProbe,windScale,slopeGlint,waterDebug) : undefined;
    const imagery = createImagery(THREE, map, source, token, sky, environment, {
        cacheBytes: budget.rasterMiB * 1024 * 1024,
        openImagery: new URLSearchParams(location.search).get("imagery"),
        compressedPages: new URLSearchParams(location.search).get("texture_cache"),
        waterModel, waterDebug, cloudProbe, planarProbe,
        windScale,slopeGlint,
        roads,
        water
    });
    const survey = require("./survey").createSurvey(
        THREE,
        map,
        sky,
        budget.rasterMiB <= 48,
        imagery.getSurfacePages,
        elevation.terrainHeight,
        imagery.getTerrainState,
        environment
    );
    elevation.setSurvey(survey);
    const canopy = require("./canopy").createCanopy(
        THREE,
        map,
        sky,
        elevation.terrainHeight,
        imagery.getSurfacePages,
        budget.rasterMiB <= 48
    );
    const buildings = createBuildings(
        THREE,
        map,
        sky,
        environment,
        elevation.terrainHeight,
        imagery.getSurfacePages,
        survey
    );
    let disposed = false,
        playing = false,
        mode = "a",
        sunHour = 14,
        lastTime = performance.now(),
        controls;
    const sun = sky.uniforms.sunDirection.value;
    const { solarUtc } = require("./ephemeris");
    const today = new Date();
    const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    function setSunHour(hour) {
        if (disposed) return;
        sunHour = hour;
        controls?.updateSun(hour);
        sky.setTime(solarUtc(midnight, hour));
        map.update();
    }
    const sharedHour = Number(params.get("sun"));
    const pose = require("./share-view").cameraPose(params.get("view"));
    if (params.has("sun") && Number.isFinite(sharedHour) && sharedHour >= 0 && sharedHour <= 24)
        setSunHour(sharedHour);
    else if (pose && (params.get("survey") === "1" || params.get("lidar") === "1"))
        setSunHour((12 + (-112.15 - pose.target.longitude) / 15 + 24) % 24);
    else setSunHour(sunHour);
    map.beforeCameraUpdate = elevation.protectCamera;
    function setMode(value) {
        mode = value;
        imagery.setMode(value);
        controls?.syncMode(value);
    }
    controls = createControls({
        source,
        getMode: () => mode,
        setMode,
        map,
        setSunHour,
        environment,
        buildings,
        canopy,
        water,
        lamps,
        shadows,
        survey,
        roads,
        setOceanRelief: imagery.setOceanRelief,
        getSunHour: () => sunHour,
        togglePlaying() {
            playing = !playing;
            lastTime = performance.now();
            return playing;
        }
    });
    if (params.get("layer") === "relief") setMode("c");
    return {
        update(entries) {
            if (disposed) return;
            const now = performance.now();
            if (playing && !document.hidden)
                setSunHour((sunHour + Math.min(now - lastTime, 100) / 30000) % 24);
            const elapsed = Math.max(0, Math.min(100, now - lastTime));
            lastTime = now;
            sky.update();
            environment.update(mode);
            cloudShadows?.update(mode);
            const entry = entries.find(e => e.dataSource === source);
            if (entry) elevation.update(entry);
            buildings.update(entries, mode);
            roads.update(mode);
            lamps.update(mode);
            const blend = environment.uniforms.buildingLightBlend;
            const target = buildings.stats.buildings > 0 ? 1 : 0;
            if (blend.value !== target) {
                const step = elapsed / 700;
                blend.value +=
                    Math.sign(target - blend.value) *
                    Math.min(step, Math.abs(target - blend.value));
                map.update();
            }
            water.update(entries, mode);
            imagery.update(entries);
            deepWater?.update(mode==="a" && water.stats.enabled,now);
            const waterVisible = mode === "a" && (water.stats.active || imagery.stats.oceanTiles > 0 || deepWater?.stats.visible);
            cloudProbe?.update(waterVisible,now);
            planarProbe?.update(entries,water.stats.shore && mode === "a",now);
            canopy.update(mode);
            shadows.update(entries, mode);
            survey.update(mode, entries);
            const preview = imagery.getPreviewPage?.();
            sky.uniforms.fallbackPreview.value = preview?.texture ?? null;
            if (preview)
                sky.uniforms.fallbackPage.value.set(
                    2 ** preview.z,
                    preview.x,
                    preview.y,
                    preview.fade
                );
            else sky.uniforms.fallbackPage.value.w = 0;
            if (playing && !document.hidden) map.update();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            map.beforeCameraUpdate = undefined;
            map.setElevationProvider(undefined);
            map.removeEventListener("didrender", observeNavigation);
            navigationQuality.dispose();
            profiler.dispose();
            controls.dispose();
            cloudShadows?.dispose();
            survey.dispose();
            shadows.dispose();
            canopy.dispose();
            buildings.dispose();
            roads.dispose();
            lamps.dispose();
            deepWater?.dispose();
            cloudProbe?.dispose();
            planarProbe?.dispose();
            water.dispose();
            imagery.dispose();
            elevation.dispose();
            environment.dispose();
            sky.dispose();
        },
        createTileMaterial: imagery.createTileMaterial,
        diagnosticImagery: {
            pages: imagery.debugPages, state: imagery.getTerrainState, configure: imagery.setDiagnostic
        },
        performance: profiler,
        reflectionStats: {model:waterModel,deep:deepWater?.stats,clouds:cloudProbe?.stats, shore:planarProbe?.stats},
        stats: imagery.stats,
        shadows,
        cloudShadows,
        water,
        lamps,
        survey,
        canopy,
        buildings,
        environment,
        roads,
        elevationProvider: elevation.elevationProvider,
        protectCamera: elevation.protectCamera,
        setSunHour,
        setMode,
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
