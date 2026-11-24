/** Orbital background mode, using the same MapView, globe material, atmosphere,
 * volumetric clouds and reconstruction as the interactive Earth application. */
import * as THREE from "three";
import { GeoCoordinates, sphereProjection } from "@xyzmaps/harp-geoutils";
import { MapView, MapViewPowerPreference, MapViewUtils } from "@xyzmaps/harp-mapview";
import { MapControls } from "@xyzmaps/harp-map-controls";
import { clipPlanes } from "./math";
const { create: createAtmosphere } = require("./atmosphere");
const { create: createEnvironment } = require("./environment");
const { createImagery } = require("./imagery");
const storageKey = "earth-background-orbit-v1";
const { createProfiler, createQualityController } = require("./performance");

function main() {
    let longitude = -30,
        latitude = 20,
        distance = 11000000,
        heading = 0,
        cloudTime = 0;
    try {
        const state = JSON.parse(sessionStorage.getItem(storageKey) || "null");
        if (Number.isFinite(state?.longitude)) longitude = state.longitude;
        if (Number.isFinite(state?.cloudTime)) cloudTime = state.cloudTime;
        if (Number.isFinite(state?.latitude))
            latitude = THREE.MathUtils.clamp(state.latitude, -85, 85);
        if (Number.isFinite(state?.distance))
            distance = THREE.MathUtils.clamp(state.distance, 2000000, 30000000);
        if (Number.isFinite(state?.heading)) heading = state.heading;
    } catch {
        /* Storage is optional. */
    }
    let startupActiveMs = 0;
    const canvas = document.getElementById("mapCanvas") as HTMLCanvasElement;
    const map = new MapView({
        canvas,
        projection: sphereProjection,
        // Keep composition dependent on viewport height, not resize history.
        fovCalculation: { type: "fixed", fov: 40 },
        theme: { styles: {} },
        clipPlanesEvaluator: clipPlanes(),
        logarithmicDepthBuffer: true,
        preferWebGL2: true,
        addBackgroundDatasource: false,
        enablePolarDataSource: false,
        synchronousRendering: true,
        powerPreference: MapViewPowerPreference.LowPower,
        enableNativeWebglAntialias: false,
        pixelRatio: 1,
        tileCacheSize: 0,
        maxVisibleDataSourceTiles: 0
    });
    const profiler = createProfiler(map),
        quality = createQualityController();
    const controls = new MapControls(map, false);
    controls.enabled = false;
    controls.tiltEnabled = false;
    controls.rotateEnabled = false;
    controls.inertiaEnabled = false;
    controls.zoomLevelDeltaOnMouseWheel = 0.15;
    canvas.tabIndex = 0;
    canvas.setAttribute(
        "aria-label",
        "Earth globe. Drag to rotate, scroll to zoom, or use arrow keys and plus or minus. Escape returns to the article."
    );
    const sky = createAtmosphere(THREE, map, { orbitalCache: true });
    // Camera orbits an illuminated Earth; lighting stays fixed in world space.
    const today = new Date();
    const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    sky.setTime(require("./ephemeris").solarUtc(midnight, 9.2));
    const environment = createEnvironment(THREE, map, sky, {
        autonomousAnimation: false,
        orbitalCoverage: true,
        initialTime: cloudTime,
        nightMapUrl: "/earth-background/lights.webp"
    });
    environment.setCloudQuality("low");
    const imagery = createImagery(THREE, map, {}, "", sky, environment, {
        baseUrl: "/earth-background/surface.webp",
        orbital: true
    });
    imagery.setContours(false);
    let paused = window.parent !== window,
        pageSuspended = false,
        disposed = false,
        ready = false,
        interactive = false,
        dragging = false,
        fastUntil = 0;
    let timer = 0,
        raf = 0,
        last = 0,
        delta = 0,
        savedAt = 0,
        deadline = 0;
    const state = () => ({
        longitude,
        latitude,
        distance,
        heading,
        interactive,
        cloudTime,
        frame: map.frameNumber,
        pixels: canvas.width * canvas.height
    });
    const notify = (type: string) => parent.postMessage({ type, ...state() }, location.origin);
    const save = () => {
        try {
            sessionStorage.setItem(storageKey, JSON.stringify(state()));
        } catch {
            /* optional */
        }
    };
    const applyView = () =>
        map.lookAt({
            target: new GeoCoordinates(latitude, longitude),
            distance,
            tilt: 0,
            heading
        });
    const captureView = () => {
        latitude = map.target.latitude;
        longitude = map.target.longitude;
        distance = map.targetDistance;
        heading = map.heading;
    };
    const resize = () => {
        environment.setCloudBudget(quality.current.cloudPixels, quality.current.cloudSteps);
        map.pixelRatio = Math.min(
            1,
            Math.sqrt(quality.current.pixels / (innerWidth * innerHeight))
        );
        map.resize(innerWidth, innerHeight);
        controls.minZoomLevel = MapViewUtils.calculateZoomLevelFromDistance(map, 30000000);
        controls.maxZoomLevel = MapViewUtils.calculateZoomLevelFromDistance(map, 2000000);
        applyView();
        if (ready && paused && !pageSuspended && !document.hidden) {
            delta = 0;
            map.renderSync();
        }
    };
    const cancel = () => {
        clearTimeout(timer);
        cancelAnimationFrame(raf);
        timer = raf = 0;
        last = deadline = 0;
    };
    map.prepareRenderTiles = entries => {
        sky.update();
        environment.update("a", delta);
        imagery.update(entries);
    };
    const schedule = () => {
        if (disposed || paused || pageSuspended || document.hidden || timer || raf) return;
        timer = window.setTimeout(
            () => {
                timer = 0;
                raf = requestAnimationFrame(now => {
                    raf = 0;
                    if (disposed || paused || pageSuspended || document.hidden) return;
                    // A page may stay paused before its images finish loading.
                    // Count active frames only, so a long hidden interval does
                    // not turn a healthy first resume into a startup failure.
                    if (!ready && last) startupActiveMs += Math.min(1000, Math.max(0, now - last));
                    if (!ready && (environment.status.errors.length || startupActiveMs > 30000)) {
                        notify("earth-background-failed");
                        dispose();
                        return;
                    }
                    delta = last && ready ? Math.min(0.5, (now - last) / 1000) : 0;
                    last = now;
                    if (!interactive) longitude = ((longitude + delta * 0.3 + 180) % 360) - 180;
                    cloudTime += delta;
                    if (!interactive) applyView();
                    const start = performance.now();
                    map.renderSync(now);
                    if (interactive) captureView();
                    if (
                        quality.observe({
                            now,
                            cpuMs: performance.now() - start,
                            gpuMs: profiler.gpuFrameMs(),
                            ready,
                            active: interactive && (dragging || now < fastUntil)
                        })
                    )
                        resize();
                    if (
                        !ready &&
                        imagery.ready &&
                        environment.status.cloudReady &&
                        environment.status.nightReady &&
                        environment.status.noiseReady
                    ) {
                        ready = true;
                        notify("earth-background-ready");
                    }
                    if (now - savedAt > 10000) {
                        save();
                        savedAt = now;
                    }
                    const fps =
                        interactive && (dragging || now < fastUntil)
                            ? quality.current.activeFps
                            : quality.current.idleFps;
                    // Start-to-start deadlines avoid adding render cost to every interval.
                    // Missed frames never trigger a catch-up burst.
                    // RAF's timestamp is the display's last frame boundary and
                    // can already be a full refresh old when this callback runs.
                    // Use the actual render start so the requested cap holds.
                    deadline = start + 1000 / fps;
                    schedule();
                });
            },
            Math.max(0, deadline - performance.now())
        );
    };
    const setPaused = (value: boolean) => {
        if (paused === value) return;
        paused = value;
        quality.suspend();
        cancel();
        save();
        schedule();
    };
    const activity = () => {
        if (!interactive) return;
        const now = performance.now();
        const alreadyFast = now < fastUntil;
        fastUntil = now + 400;
        // A stream of trackpad events must not keep cancelling the next frame.
        if (!alreadyFast) cancel();
        schedule();
    };
    const setInteractive = (value: boolean) => {
        if (interactive === value) return;
        if (ready) captureView();
        interactive = value;
        controls.enabled = value;
        dragging = false;
        canvas.style.cursor = value ? "grab" : "default";
        if (value) canvas.focus({ preventScroll: true });
        else save();
        activity();
    };
    const command = (value: string) => {
        if (!interactive) return;
        if (value === "zoom-in" || value === "zoom-out") {
            controls.setZoomLevel(map.zoomLevel + (value === "zoom-in" ? 0.4 : -0.4));
        } else if (value === "reset") {
            latitude = 20;
            longitude = -30;
            distance = 11000000;
            heading = 0;
            applyView();
        }
        activity();
    };
    const keydown = (event: KeyboardEvent) => {
        if (!interactive) return;
        if (event.key === "Escape") {
            event.preventDefault();
            notify("earth-background-exit");
        } else if (event.key === "Tab") {
            event.preventDefault();
            notify("earth-background-focus-controls");
        } else if (["+", "=", "-", "Home"].includes(event.key)) {
            event.preventDefault();
            command(event.key === "Home" ? "reset" : event.key === "-" ? "zoom-out" : "zoom-in");
        } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            captureView();
            const step = event.shiftKey ? 10 : 3;
            longitude += event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
            latitude = THREE.MathUtils.clamp(
                latitude + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0),
                -85,
                85
            );
            applyView();
            activity();
        }
    };
    const pointerdown = (event: PointerEvent) => {
        if (!interactive) return;
        dragging = true;
        canvas.focus({ preventScroll: true });
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = "grabbing";
        activity();
    };
    const pointerup = () => {
        dragging = false;
        canvas.style.cursor = interactive ? "grab" : "default";
        activity();
    };
    const message = (event: MessageEvent) => {
        if (event.source !== parent || event.origin !== location.origin) return;
        if (event.data?.type === "earth-background-active") {
            setInteractive(event.data.interactive === true);
            setPaused(!event.data.active);
        }
        if (event.data?.type === "earth-background-command") command(event.data.command);
    };
    const visibility = () => {
        quality.suspend();
        cancel();
        save();
        schedule();
    };
    const lost = () => {
        cancel();
        paused = true;
        notify("earth-background-failed");
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        cancel();
        save();
        profiler.dispose();
        removeEventListener("resize", resize);
        removeEventListener("message", message);
        removeEventListener("pagehide", pagehide);
        removeEventListener("pageshow", pageshow);
        document.removeEventListener("visibilitychange", visibility);
        canvas.removeEventListener("webglcontextlost", lost);
        canvas.removeEventListener("pointerdown", pointerdown);
        canvas.removeEventListener("pointerup", pointerup);
        canvas.removeEventListener("pointercancel", pointerup);
        canvas.removeEventListener("wheel", activity);
        removeEventListener("keydown", keydown);
        controls.dispose();
        map.prepareRenderTiles = undefined;
        imagery.dispose();
        environment.dispose();
        sky.dispose();
        map.dispose();
    };
    const pagehide = (event: PageTransitionEvent) => {
        if (!event.persisted) dispose();
        else {
            pageSuspended = true;
            visibility();
        }
    };
    const pageshow = () => {
        pageSuspended = false;
        visibility();
    };
    addEventListener("resize", resize);
    addEventListener("message", message);
    addEventListener("pagehide", pagehide);
    addEventListener("pageshow", pageshow);
    document.addEventListener("visibilitychange", visibility);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("pointerdown", pointerdown);
    canvas.addEventListener("pointerup", pointerup);
    canvas.addEventListener("pointercancel", pointerup);
    canvas.addEventListener("wheel", activity, { passive: true });
    addEventListener("keydown", keydown);
    resize();
    // This source-owned event also lets regression tests inspect the real MapView.
    window.dispatchEvent(
        new CustomEvent("earth-ready", {
            detail: {
                map,
                THREE,
                environment,
                imagery,
                background: { state, setPaused, dispose, performance: profiler, quality }
            }
        })
    );
    notify("earth-background-loaded");
    schedule();
}
try {
    main();
} catch (error) {
    parent.postMessage({ type: "earth-background-failed" }, location.origin);
    console.error("Earth background initialization failed", error);
}
