import * as THREE from "three";
import { sphereProjection, GeoCoordinates } from "@xyzmaps/harp-geoutils";
import { MapView, MapViewEventNames } from "@xyzmaps/harp-mapview";
import { MapControls, MapControlsUI } from "@xyzmaps/harp-map-controls";
import { EarthTerrainDataSource } from "./terrain-data-source";
import { create, clipPlanes, EarthRuntime } from "./runtime";
import { create as createContinuity } from "./continuity";

export type EarthMap = MapView & { earth: EarthRuntime };
function initializeMapView(id: string): MapView {
    const canvas = document.getElementById(id) as HTMLCanvasElement;
    return new MapView({
        canvas,
        projection: sphereProjection,
        theme: "resources/earth-theme.json",
        decoderUrl: "decoder.bundle.js",
        clipPlanesEvaluator: clipPlanes(),
        logarithmicDepthBuffer: true,
        addBackgroundDatasource: false,
        enablePolarDataSource: false,
        tileCacheSize: 200,
        maxVisibleDataSourceTiles: 100
    });
}
export async function main(): Promise<EarthMap> {
    const map = initializeMapView("mapCanvas");
    const token = new URLSearchParams(location.search).get("mapbox_token") || "";
    const terrain = new EarthTerrainDataSource(token);
    const earth = create(THREE, map, terrain, token);
    const earthMap = map as EarthMap;
    earthMap.earth = earth;
    const reconcile = createContinuity(THREE, terrain);
    map.prepareRenderTiles = entries => {
        reconcile(entries);
        earth.update(entries);
    };
    map.setElevationProvider(earth.elevationProvider);
    const controls = new MapControls(map, false);
    controls.maxTiltAngle = 89;
    const ui = new MapControlsUI(controls);
    ui.domElement.id = "earth-navigation";
    const navigationLabels = ["Zoom in", "Zoom out", "Reset north", "Toggle tilt"];
    ui.domElement.querySelectorAll("button").forEach((button, index) => {
        button.setAttribute("aria-label", navigationLabels[index]);
        button.title = navigationLabels[index];
    });
    map.canvas.parentElement!.appendChild(ui.domElement);
    const resize = () => map.resize(innerWidth, innerHeight);
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
                    buildings: earth.buildings.stats
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
        removeEventListener("keydown", keydown);
        removeEventListener("pagehide", pagehide);
        removeEventListener("pageshow", pageshow);
        map.removeEventListener(MapViewEventNames.AfterRender, renderHud);
        map.prepareRenderTiles = undefined;
        earth.dispose();
        controls.dispose();
        ui.domElement.remove();
        hud.remove();
    });
    await map.addDataSource(terrain);
    map.lookAt({
        target: new GeoCoordinates(36.1, -112.15, 0),
        distance: 90000,
        tilt: 65,
        heading: 28
    });
    // Test helpers instrument this source-owned marker; production exposes no global map.
    window.dispatchEvent(new CustomEvent("earth-ready", { detail: { map: earthMap, THREE } }));
    return earthMap;
}
