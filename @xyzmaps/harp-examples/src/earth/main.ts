import * as THREE from "three";
import { earthWorkerUrl } from "./worker-url";
import { sphereProjection, GeoCoordinates } from "@xyzmaps/harp-geoutils";
import { MapView, MapViewEventNames } from "@xyzmaps/harp-mapview";
import { MapControls, MapControlsUI } from "@xyzmaps/harp-map-controls";
import { cameraPose, terrainPackUrl } from "./share-view";
import { EarthTerrainDataSource, loadWorldTerrain, supportsWorldTerrain } from "./terrain-data-source";
import { create, clipPlanes, EarthRuntime } from "./runtime";
import { create as createContinuity } from "./continuity";
import { createTerrainTransitions } from "./terrain-transition";

export type EarthMap = MapView & { earth: EarthRuntime };
function initializeMapView(id: string): MapView {
    const canvas = document.getElementById(id) as HTMLCanvasElement;
    const budget = require("./device-budgets").deviceBudgets(navigator);
    return new MapView({
        canvas,
        projection: sphereProjection,
        theme: "resources/earth-theme.json",
        decoderUrl: earthWorkerUrl("earth-decoder"),
        clipPlanesEvaluator: clipPlanes(),
        logarithmicDepthBuffer: true,
        preferWebGL2: true,
        sharpenDynamicRendering: true,
        useTerrainFootprintLod: true,
        addBackgroundDatasource: false,
        enablePolarDataSource: false,
        tileCacheSize: budget.terrainMiB,
        maxVisibleDataSourceTiles: budget.visibleTiles
    });
}
export async function main(): Promise<EarthMap> {
    const params = new URLSearchParams(location.search);
    const pose = cameraPose(params.get("view"));
    const map = initializeMapView("mapCanvas");
    if (pose) map.lookAt(pose);
    const token = params.get("mapbox_token") || "";
    const pack = terrainPackUrl(params.get("terrain_pack"), location.href);
    const closeOpening = pose && pose.distance < 2200;
    if (closeOpening) map.canvas.style.opacity = "0";
    const open = supportsWorldTerrain()
        ? await loadWorldTerrain().catch(() => undefined) : undefined;
    const terrain = new EarthTerrainDataSource(token, pack, open);
    const imagery = require("./open-imagery").sources[params.get("imagery") ?? ""];
    if (imagery?.prepare) {
        try {
            await imagery.prepare();
        } catch {
            const notice = document.createElement("p");
            notice.setAttribute("role", "status");
            notice.style.cssText = "position:absolute;bottom:35px;left:12px;color:white;background:#18232c;padding:8px";
            notice.textContent = imagery.name + " is unavailable. Showing the globe overview. Reload to retry.";
            document.body.appendChild(notice);
        }
    }
    const earth = create(THREE, map, terrain, token);
    const earthMap = map as EarthMap;
    earthMap.earth = earth;
    const transition = createTerrainTransitions(THREE, map, map.visibleTileSet.getNumberOfVisibleTiles() <= 65 ? 80000 : 140000);
    const reconcile = createContinuity(THREE, terrain, transition);
    map.prepareRenderTiles = entries => {
        reconcile(entries);
        earth.update(entries);
    };
    map.setElevationProvider(earth.elevationProvider);
    const diagnostics = require("./diagnostics").setupDiagnostics(THREE, map, earth, terrain);
    const controls = new MapControls(map, false);
    controls.maxTiltAngle = 89;
    controls.continuousWheelZoom = true;
    controls.zoomLevelDeltaOnMouseWheel = 0.32;
    controls.zoomInertiaDampingDuration = 0.15;
    const ui = new MapControlsUI(controls);
    ui.domElement.id = "earth-navigation";
    const navigationLabels = ["Zoom in", "Zoom out", "Reset north", "Toggle tilt"];
    ui.domElement.querySelectorAll("button").forEach((button, index) => {
        button.setAttribute("aria-label", navigationLabels[index]);
        button.title = navigationLabels[index];
    });
    map.canvas.parentElement!.appendChild(ui.domElement);
    const { softwareRasterizer, softwarePixelRatio } = require("./device-budgets");
    let software = softwareRasterizer(map.renderer.getContext());
    const resize = () => {
        map.pixelRatio = software
            ? softwarePixelRatio(innerWidth, innerHeight, devicePixelRatio)
            : devicePixelRatio;
        map.resize(innerWidth, innerHeight);
    };
    // Chromium can restore a failed hardware context with SwiftShader.
    const rendererRestored = () => {
        software = softwareRasterizer(map.renderer.getContext());
        resize();
    };
    map.canvas.addEventListener("webglcontextrestored", rendererRestored);
    addEventListener("resize", resize);
    resize();
    let contours = true,
        hillshade = 0.6,
        showHud = false;
    const hud = document.createElement("pre");
    hud.style.cssText =
        "position:absolute;top:8px;left:8px;color:#b8e6ff;background:#102030dd;padding:10px;pointer-events:none;font:11px monospace;display:none";
    document.body.appendChild(hud);
    const renderHud = () => {
        if (showHud)
            hud.textContent = JSON.stringify(
                {
                    zoom: map.zoomLevel,
                    altitude: map.camera.position.length() - 6378137,
                    near: map.camera.near,
                    far: map.camera.far,
                    imagery: earth.stats,
                    buildings: earth.buildings.stats,
                    performance: earth.performance.snapshot()
                },
                null,
                2
            );
    };
    const keydown = (event: KeyboardEvent) => {
        if ((event.target as HTMLElement)?.matches("input,select,button")) return;
        if (event.key === "1") earth.setMode("a");
        if (event.key === "2") earth.setMode("c");
        if (event.key.toLowerCase() === "c") earth.setContours((contours = !contours));
        if (event.key === "+" || event.key === "=")
            earth.setHillshade((hillshade = Math.min(1, hillshade + 0.1)));
        if (event.key === "-") earth.setHillshade((hillshade = Math.max(0, hillshade - 0.1)));
        if (event.key.toLowerCase() === "h") {
            showHud = !showHud;
            hud.style.display = showHud ? "block" : "none";
            map.update();
        }
    };
    addEventListener("keydown", keydown);
    map.addEventListener(MapViewEventNames.AfterRender, renderHud);
    const pagehide = (event: PageTransitionEvent) => {
        if (!event.persisted) map.dispose();
    };
    const pageshow = () => map.update();
    addEventListener("pagehide", pagehide);
    addEventListener("pageshow", pageshow);
    map.addEventListener(MapViewEventNames.Dispose, () => {
        removeEventListener("resize", resize);
        map.canvas.removeEventListener("webglcontextrestored", rendererRestored);
        removeEventListener("keydown", keydown);
        removeEventListener("pagehide", pagehide);
        removeEventListener("pageshow", pageshow);
        map.removeEventListener(MapViewEventNames.AfterRender, renderHud);
        map.prepareRenderTiles = undefined;
        diagnostics.dispose();
        earth.dispose();
        controls.dispose();
        ui.domElement.remove();
        hud.remove();
    });
    await map.addDataSource(terrain);
    map.lookAt(
        pose ?? {
            target: new GeoCoordinates(36.1, -112.15, 0),
            distance: 90000,
            tilt: 65,
            heading: 28
        }
    );
    if (closeOpening) require("./opening-ground").revealGround(map, terrain, pose);
    // Test helpers instrument this source-owned marker; production exposes no global map.
    window.dispatchEvent(new CustomEvent("earth-ready", { detail: { map: earthMap, THREE } }));
    return earthMap;
}
