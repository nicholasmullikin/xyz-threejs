const { providers, providerOf } = require("./terrain-providers");
const {
    coordinates,
    contains,
    sourceLevel,
    indexTiles,
    samplePatch,
    projectPatch,
    outline,
    difference,
    side
} = require("./diagnostic-surface");
const { diagnosticRender } = require("./diagnostic-render");
const { sourceLevel: imageLevel } = require("./imagery-provider");

function setupDiagnostics(THREE, map, earth, source) {
    let selectionStop,
        largestStep = 0;
    let open = false,
        pin,
        armed = false,
        history = [],
        recording = [],
        replay,
        previous,
        lastOwner,
        lastSwap,
        lastInfo = 0,
        lastTime;
    const options = { hold: false, holdTerrain: false, holdImagery: false, prefetchOff: false };
    let gpu;
    function el(tag, parent, txt) {
        const node = document.createElement(tag);
        if (txt) node.textContent = txt;
        parent.appendChild(node);
        return node;
    }
    const panel = el("section", document.body);
    panel.setAttribute("aria-label", "Terrain diagnostics");
    panel.style.cssText =
        "position:absolute;z-index:120;right:10px;top:60px;width:min(375px,calc(100vw - 28px));max-height:78vh;overflow:auto;background:#101b25f5;color:#f1f6fa;padding:12px;border-radius:7px;font:13px/1.45 system-ui;box-sizing:border-box";
    panel.hidden = true;
    const style = el("style", panel);
    style.textContent = `section[aria-label="Terrain diagnostics"] :is(button,select){font:inherit;color:#e7f1fa;background:#253643;border:1px solid #627584;border-radius:4px;padding:.22em .5em;margin:2px;cursor:pointer}
    section[aria-label="Terrain diagnostics"] label{margin-top:.25em}
    section[aria-label="Terrain diagnostics"] small{display:block;color:#b6cad6}
    section[aria-label="Terrain diagnostics"] [hidden]{display:none}`;
    const row = el("div", panel);
    row.style.cssText = "display:flex;align-items:center;justify-content:space-between";
    el("strong", row, "Terrain diagnostics");
    function button(parent, name, fn) {
        const b = el("button", parent, name);
        b.type = "button";
        b.onclick = fn;
        return b;
    }
    button(row, "Close", () => toggle(false));
    const label = el("label", panel, "View ");
    const view = el("select", label);
    const modes = [
        "Inspector",
        "Terrain source",
        "Hierarchy",
        "Terrain pages",
        "Imagery pages",
        "Triangles",
        "Selected patch",
        "Parent patch",
        "Best resident patch",
        "Depth",
        "Overdraw",
        "Primitives",
        "Instances"
    ];
    for (const name of modes) el("option", view, name);
    const facts = {
        "Terrain source": "Colors identify the elevation mesh drawn at each patch. Pin ground to follow a handoff.",
        Inspector:
            "Click Pin ground, then click the terrain. Measurements follow that geographic patch.",
        Hierarchy:
            "Colors show terrain levels. White marks the drawn owner, pink the parent boundary, and gold its child divisions.",
        "Terrain pages":
            "Local tile footprints around the pin. Outlines show the overlapping states.",
        "Imagery pages":
            "Local imagery footprints around the pin. Outlines show the overlapping states.",
        Triangles: "Wireframe of the terrain geometry submitted this frame.",
        "Selected patch":
            "Currently drawn triangles clipped to the pinned footprint, with neutral lighting.",
        "Parent patch": "Closest cached coarser mesh covering the pinned footprint.",
        "Best resident patch":
            "Finest cached elevation available at each sample inside the pinned footprint.",
        Depth: "Main-scene mesh depth in camera space, logarithmic. Near is white.",
        Overdraw:
            "Additive mesh coverage before depth rejection. Brighter means more layers. Offscreen cloud passes and material discards are excluded.",
        Primitives: "Main-scene mesh draw objects colored by identity.",
        Instances:
            "Instanced meshes colored by instance transform. Canopy cards and mapped building footprints use their own identifiers."
    };
    const help = el("div", panel);
    help.textContent = facts.Inspector;
    const sourceLegend = el("div", panel);
    sourceLegend.hidden = true;
    for (const [name, color] of providers) {
        const item = el("span", sourceLegend, "■ " + name);
        item.style.cssText = "display:inline-block;margin-right:.6em;color:" + color;
    }
    function pickAt(x, y) {
        const hit = earth.elevationProvider.rayCast(x, y);
        if (!hit) {
            help.textContent = "No terrain hit. Pick a ground surface.";
            return;
        }
        const geo = map.projection.unprojectPoint(hit);
        const mx = ((geo.longitude + 180) / 360 + 1) % 1;
        const my = (1 - Math.asinh(Math.tan((geo.latitude * Math.PI) / 180)) / Math.PI) / 2;
        const owner = indexTiles(cut()).find(t => contains(t, mx, my));
        if (!owner) {
            help.textContent = "Terrain geometry is still loading.";
            return;
        }
        // Bootstrap tiles may span a continent. Inspect a stable local area even
        // if the camera is close to ground before the fine tiles arrive.
        const distance = map.camera.position.distanceTo(hit);
        const spanMeters = Math.max(1, (distance * 0.5) / map.camera.projectionMatrix.elements[5]);
        const z = Math.min(
            22,
            Math.max(
                owner.tileKey.level,
                Math.ceil(
                    Math.log2((40075017 * Math.cos((geo.latitude * Math.PI) / 180)) / spanMeters)
                )
            )
        );
        pin = {
            mx,
            my,
            key: { z, x: Math.floor(mx * 2 ** z), y: Math.floor(my * 2 ** z) },
            latitude: geo.latitude,
            longitude: geo.longitude,
            altitude: geo.altitude
        };
        source.stationaryTileSelectionRevision++;
        selectionStop = undefined;
        largestStep = 0;
        previous = lastOwner = lastSwap = undefined;
        lastInfo = 0;
        help.textContent = facts[view.value];
        map.update();
    }
    function cut() {
        const entry = map.visibleTileSet.dataSourceTileList.find(e => e.dataSource === source);
        return Array.from(entry?.renderedTiles.values() || []);
    }
    function click(e) {
        if (!open || !armed) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        armed = false;
        const r = map.canvas.getBoundingClientRect();
        pickAt(e.clientX - r.left, e.clientY - r.top);
    }
    map.canvas.addEventListener("pointerdown", click, true);
    const actions = el("div", panel);
    button(actions, "Pin ground", () => {
        armed = true;
        help.textContent = "Click a point on the terrain.";
    });
    button(actions, "Pin center", () =>
        pickAt(map.canvas.clientWidth / 2, map.canvas.clientHeight / 2)
    );
    const switches = [];
    function check(name, field) {
        const l = el("label", panel);
        l.style.display = "block";
        const input = el("input", l);
        input.type = "checkbox";
        l.append(" " + name);
        input.onchange = () => {
            options[field] = input.checked;
            earth.diagnosticImagery.configure(options);
        };
        switches.push(input);
    }
    check("Hold new terrain tile requests", "holdTerrain");
    check("Hold new imagery tile requests", "holdImagery");
    check("Disable retreat-parent and imagery preview prefetch", "prefetchOff");
    const mini = el("canvas", panel);
    mini.width = 320;
    mini.height = 165;
    mini.style.width = "100%";
    const legend = el("small", panel);
    const info = el("pre", panel);
    info.style.cssText = "white-space:pre-wrap;font:12px/1.5 monospace;margin:6px 0";
    const tools = el("div", panel);
    button(tools, "Capture last 5 s", () => {
        recording = history.slice();
        status.textContent = recording.length + " frames captured";
    });
    button(tools, "Replay camera", () => {
        if (recording.length) {
            replay = { start: performance.now(), frames: recording.slice(), i: 0 };
            map.update();
        }
    });
    button(tools, "Export capture", () => {
        const frames = recording.length ? recording : history;
        const blob = new Blob([JSON.stringify({ version: 1, pin, frames })], {
            type: "application/json"
        });
        const url = URL.createObjectURL(blob),
            a = el("a", panel);
        a.href = url;
        a.download = "earth-terrain-capture.json";
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const status = el("small", panel);
    const overlay = el("canvas", document.body);
    overlay.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2";
    overlay.hidden = true;
    const marker = el("div", document.body);
    marker.setAttribute("aria-hidden", "true");
    marker.style.cssText =
        "position:fixed;z-index:3;pointer-events:none;width:10px;height:10px;border:2px solid white;box-shadow:0 0 0 1px #172b35;border-radius:50%;transform:translate(-50%,-50%)";
    marker.hidden = true;
    const markerPoint = new THREE.Vector3();
    const ctx = overlay.getContext("2d"),
        mctx = mini.getContext("2d");
    const pagesColors = {
        resident: "#788ca5",
        drawn: "#6ee9ae",
        desired: "#ffd764",
        queued: "#b09aff",
        loading: "#ff806c"
    };
    function paintPages(data, level) {
        const w = mini.width,
            h = mini.height;
        mctx.fillStyle = "#111820";
        mctx.fillRect(0, 0, w, h);
        if (!pin) return;
        const span = 2.7 / 2 ** level,
            scale = w / span;
        for (const [name, color] of Object.entries(pagesColors)) {
            mctx.strokeStyle = color;
            const inset = Object.keys(pagesColors).indexOf(name) * 1.4;
            for (const item of data[name] || []) {
                const { x, y, z } = coordinates(item),
                    n = 2 ** z;
                if (!Number.isFinite(n)) continue;
                const left = (x / n - pin.mx) * scale + w / 2,
                    top = (y / n - pin.my) * scale + h / 2,
                    sz = scale / n;
                if (left > w || top > h || left + sz < 0 || top + sz < 0) continue;
                mctx.strokeRect(
                    left + inset,
                    top + inset,
                    Math.max(1, sz - 2 * inset),
                    Math.max(1, sz - 2 * inset)
                );
            }
        }
        mctx.fillStyle = "white";
        mctx.fillRect(w / 2 - 2, h / 2 - 2, 4, 4);
    }
    const menu = document.querySelector(".earth-compare") || document.body;
    const launch = button(menu, "Terrain diagnostics", () => {
        if (!menu.hidden) menu.querySelector("button")?.click();
        toggle(true);
    });
    function toggle(value) {
        open = value;
        panel.hidden = !value;
        armed = false;
        source.diagnostic = value ? options : undefined;
        source.stationaryTileSelectionRevision++;
        source.traceTileSelection = value
            ? (key, reason, area, threshold) => {
                  if (options.traceFrame !== map.frameNumber) {
                      options.traceFrame = map.frameNumber;
                      options.counts = {};
                      selectionStop = undefined;
                  }
                  options.counts[reason] = (options.counts[reason] || 0) + 1;
                  if (pin && contains(key, pin.mx, pin.my))
                      selectionStop = { reason, key: path(key), area, threshold };
              }
            : undefined;
        earth.diagnosticImagery.configure(value ? options : undefined);
        if (!value) {
            gpu?.dispose();
            gpu = undefined;
            options.holdTerrain = options.holdImagery = options.prefetchOff = false;
            selectionStop = undefined;
            lastTime = undefined;
            switches.forEach(s => (s.checked = false));
            marker.hidden = overlay.hidden = true;
            ctx.clearRect(0, 0, overlay.width, overlay.height);
            replay = previous = undefined;
            history = [];
            options.candidates = options.desired = options.requests = undefined;
        } else if (!pin) pickAt(map.canvas.clientWidth / 2, map.canvas.clientHeight / 2);
        lastInfo = 0;
        map.update();
    }
    function keys(e) {
        if (e.target?.matches("input,select,textarea") || e.ctrlKey || e.metaKey || e.altKey)
            return;
        if (e.key.toLowerCase() === "d") {
            e.preventDefault();
            toggle(!open);
        }
        if (open && e.key === "Escape") toggle(false);
    }
    addEventListener("keydown", keys);
    view.onchange = () => {
        help.textContent = facts[view.value];
        lastInfo = 0;
        map.update();
    };
    function path(e) {
        return e ? Object.values(coordinates(e)).join("/") : "—";
    }
    function frame() {
        if (!open) return;
        const time = performance.now(),
            tiles = indexTiles(cut()),
            mode = view.value;
        if (!pin && tiles.length) pickAt(map.canvas.clientWidth / 2, map.canvas.clientHeight / 2);
        const owner = pin && tiles.find(t => contains(t, pin.mx, pin.my));
        const atPin = items =>
            pin &&
            items
                ?.filter(e => contains(e, pin.mx, pin.my))
                .sort((a, b) => coordinates(b).z - coordinates(a).z)[0];
        const candidates = options.candidates || [],
            desired = options.desired || [],
            req = options.requests || [];
        const wanted = atPin(desired),
            candidate = atPin(candidates),
            request = atPin(req);
        const morph = owner?.objects[0]?.geometry.userData.terrainTransition;
        const cached = [];
        if (pin) map.visibleTileSet.forEachCachedTile(t => cached.push(t), source);
        const residents = indexTiles(cached, true);
        const state = owner && earth.diagnosticImagery.state(coordinates(owner));
        const img = [];
        if (state) {
            if (state.mix < 1) img.push([state.from.entry, 1 - state.mix, "base"]);
            if (state.mix > 0) img.push([state.to.entry, state.mix, "base"]);
            for (const d of state.details || [])
                if (d.alpha > 0 && contains(d.entry, pin.mx, pin.my))
                    img.push([d.entry, d.alpha, "detail"]);
        }
        const levels = img.map(
            ([e, a, kind]) =>
                kind +
                " " +
                (e.z < 0 ? "overview" : "z" + imageLevel(e)) +
                " " +
                Math.round(a * 100) +
                "%"
        );
        const closest =
            pin &&
            residents
                .filter(
                    t =>
                        t.tileKey.level < (owner?.tileKey.level ?? pin.key.z) &&
                        contains(t, pin.mx, pin.my)
                )
                .sort((a, b) => b.tileKey.level - a.tileKey.level)[0];
        const w = map.canvas.width,
            h = map.canvas.height;
        let span = null,
            step = null,
            bestSpan = null;
        if (pin && (owner || closest)) {
            const intersects = t => {
                const k = coordinates(t),
                    p = pin.key,
                    z = Math.min(k.z, p.z);
                return (
                    k.x >> (k.z - z) === p.x >> (p.z - z) && k.y >> (k.z - z) === p.y >> (p.z - z)
                );
            };
            const current = samplePatch(THREE, pin.key, tiles.filter(intersects));
            const selected = projectPatch(THREE, map, current);
            const contour = s => outline(s, w, h);
            const selectedLine = contour(selected);
            const parent =
                closest && projectPatch(THREE, map, samplePatch(THREE, pin.key, [closest], true));
            if (parent) span = difference(selectedLine, contour(parent));
            if (previous)
                step = difference(selectedLine, contour(projectPatch(THREE, map, previous)));
            previous = current;
            const best = projectPatch(
                THREE,
                map,
                samplePatch(THREE, pin.key, residents.filter(intersects), true)
            );
            if (parent) bestSpan = difference(contour(best), contour(parent));
            if (step != null) largestStep = Math.max(largestStep, step);
        }
        const patchMode = mode.endsWith("patch");
        sourceLegend.hidden = mode !== "Terrain source";
        overlay.hidden = mode !== "Hierarchy";
        if (pin && owner) {
            map.projection.projectPoint(
                { ...pin, altitude: earth.elevationProvider.getHeight(pin) ?? pin.altitude },
                markerPoint
            );
            markerPoint.project(map.camera);
            const r = map.canvas.getBoundingClientRect();
            marker.hidden =
                markerPoint.z < -1 ||
                markerPoint.z > 1 ||
                Math.abs(markerPoint.x) > 1 ||
                Math.abs(markerPoint.y) > 1;
            marker.style.left = r.left + ((1 + markerPoint.x) * r.width) / 2 + "px";
            marker.style.top = r.top + ((1 - markerPoint.y) * r.height) / 2 + "px";
        } else marker.hidden = true;
        if (patchMode) {
            const candidates =
                mode === "Selected patch"
                    ? tiles
                    : mode === "Parent patch"
                      ? closest
                          ? [closest]
                          : []
                      : residents;
            (gpu ??= diagnosticRender(THREE, map)).patch(
                pin?.key,
                candidates,
                mode !== "Selected patch"
            );
        }
        if (mode === "Hierarchy") {
            if (overlay.width !== w || overlay.height !== h) {
                overlay.width = w;
                overlay.height = h;
            }
            ctx.clearRect(0, 0, w, h);
            // Project the actual drawn surface into parent/child footprint outlines.
            if (owner && pin) {
                const k = coordinates(owner);
                const parent = { z: Math.max(0, k.z - 1), x: k.x >> 1, y: k.y >> 1 };
                const p = projectPatch(THREE, map, samplePatch(THREE, parent, tiles));
                ctx.lineWidth = Math.max(1, w / map.canvas.clientWidth);
                function line(indices, color) {
                    ctx.strokeStyle = color;
                    ctx.beginPath();
                    let pen = false;
                    for (const i of indices) {
                        const v = p[i];
                        if (!v) {
                            pen = false;
                            continue;
                        }
                        if (pen) ctx.lineTo(...v);
                        else ctx.moveTo(...v);
                        pen = true;
                    }
                    ctx.stroke();
                }
                for (const i of [0, 8, 16]) {
                    const color = i === 8 ? "#ffcc6b" : "#ff7293";
                    line(
                        Array.from({ length: side }, (_, j) => i * side + j),
                        color
                    );
                    line(
                        Array.from({ length: side }, (_, j) => j * side + i),
                        color
                    );
                }
            }
        }
        if (
            ["Terrain source", "Hierarchy", "Triangles", "Depth", "Overdraw", "Instances", "Primitives"].includes(
                mode
            )
        )
            (gpu ??= diagnosticRender(THREE, map)).draw(mode, tiles, owner);
        const pages = mode.endsWith("pages");
        mini.hidden = legend.hidden = !pages;
        const why = [];
        if (selectionStop && (candidate || selectionStop.reason.startsWith("outside")))
            why.push(selectionStop.reason);
        if (!candidate) why.push("Outside current candidate set");
        if (candidate && wanted && coordinates(candidate).z > coordinates(wanted).z)
            why.push("Selection budget / fallback cut");
        if (wanted && owner && owner.tileKey.level < coordinates(wanted).z)
            why.push("Coarse cover for finer target");
        if (owner?.objects[0]?.userData.terrainCropLevel !== undefined)
            why.push("Cropped ancestor");
        if (owner?.objects[0]?.userData.debugBudgetFrame === map.frameNumber)
            why.push("Morph vertex budget");
        if (morph) why.push(morph.retiring ? "Morph toward parent" : "Morph toward fine mesh");
        const id = path(owner);
        if (lastOwner && lastOwner !== id)
            lastSwap = lastOwner + " → " + id + " · " + (why.join(", ") || "draw cut changed");
        lastOwner = id;
        const cam = {
            target: {
                latitude: map.target.latitude,
                longitude: map.target.longitude,
                altitude: map.target.altitude
            },
            distance: map.targetDistance,
            heading: map.heading,
            tilt: map.tilt
        };
        const baseProvider = owner && providers[providerOf(owner.objects[0])][0];
        const lidarWeight = pin && earth.survey.lidarWeightAt(pin.mx, pin.my);
        const terrainSource = lidarWeight != null
            ? "USGS lidar (" + Math.round(lidarWeight * 100) + "% detail over " + (baseProvider || "base") + ")"
            : baseProvider;
        history.push({
            terrainSource,
            time,
            cam,
            pin: pin?.key,
            owner: id,
            candidate: path(candidate),
            desired: path(wanted),
            requested: path(request),
            elevation: owner && sourceLevel(owner),
            imagery: levels,
            why,
            step,
            span,
            bestSpan,
            selectionStop,
            cullCounts: options.counts,
            buffer: [w, h],
            ratio: map.dynamicPixelRatio ?? map.pixelRatio,
            frameMs: lastTime ? time - lastTime : null
        });
        lastTime = time;
        while (history.length && (time - history[0].time > 5000 || history.length > 900))
            history.shift();
        if (time - lastInfo > 110 || !lastInfo) {
            const fmt = n => (n == null ? "—" : n.toFixed(2) + " px");
            info.textContent = [
                pin
                    ? "Pin " + pin.latitude.toFixed(5) + ", " + pin.longitude.toFixed(5)
                    : "No ground pinned",
                "Terrain source " + (terrainSource || "—"),
                "Candidate " + path(candidate) + "   target " + path(wanted),
                "Planner request " + path(request) + "   drawn " + id,
                "Elevation " +
                    (owner ? "z" + sourceLevel(owner) : "—") +
                    "   imagery " +
                    (levels.join(" + ") || "—"),
                "Finest cached at pin " +
                    path(pin && residents.find(t => contains(t, pin.mx, pin.my))),
                "Visible candidates " +
                    candidates.length +
                    "   selected " +
                    desired.length +
                    "   drawn " +
                    tiles.length,
                options.counts &&
                    "Frustum rejects " +
                        (options.counts["outside frustum or zero projected area"] || 0) +
                        "   area stops " +
                        (options.counts["projected area below split threshold"] || 0),
                why.join(" · ") || "Drawn at selected level",
                lastSwap && "Last swap " + lastSwap,
                "Sampled patch outline (native pixels)",
                "Drawn ↔ parent " + fmt(span) + "   best ↔ parent " + fmt(bestSpan),
                "Last frame " + fmt(step) + "   max since pin " + fmt(largestStep),
                mode === "Overdraw" &&
                    "Cloud pass " +
                        earth.environment.cloudStats.width +
                        " × " +
                        earth.environment.cloudStats.height +
                        " · " +
                        earth.environment.cloudStats.steps +
                        " ray steps",
                w +
                    " × " +
                    h +
                    " buffer · navigation DPR " +
                    (map.dynamicPixelRatio ?? map.pixelRatio)
            ]
                .filter(Boolean)
                .join("\n");
            if (pages) {
                let data;
                if (mode === "Terrain pages")
                    data = {
                        resident: residents,
                        drawn: tiles,
                        desired,
                        queued: req.filter(e => !cached.some(t => path(e) === path(t))),
                        loading: cached.filter(t => !t.hasGeometry && !t.disposed)
                    };
                else {
                    const p = earth.diagnosticImagery.pages(),
                        drawn = [];
                    for (const t of tiles) {
                        const s = earth.diagnosticImagery.state(coordinates(t));
                        if (!s) continue;
                        if (s.mix < 1) drawn.push(s.from.entry);
                        if (s.mix > 0) drawn.push(s.to.entry);
                        for (const d of s.details || []) if (d.alpha > 0) drawn.push(d.entry);
                    }
                    data = { ...p, loading: p.pending, drawn: drawn.filter(e => e.z >= 0) };
                }
                paintPages(data, owner?.tileKey.level ?? pin.key.z);
                legend.textContent =
                    "Gray resident · green drawn · yellow desired · purple queued · coral loading";
            }
            lastInfo = time;
        }
        if (replay) {
            const frames = replay.frames,
                elapsed = time - replay.start;
            while (
                replay.i + 1 < frames.length &&
                frames[replay.i + 1].time - frames[0].time <= elapsed
            )
                replay.i++;
            map.lookAt(frames[replay.i].cam);
            map.update();
            if (replay.i === frames.length - 1) {
                replay = undefined;
                status.textContent = "Replay complete";
            }
        }
    }
    map.addEventListener("didrender", frame);
    if (new URLSearchParams(location.search).get("diagnostics") === "1") toggle(true);
    return {
        dispose() {
            map.removeEventListener("didrender", frame);
            removeEventListener("keydown", keys);
            map.canvas.removeEventListener("pointerdown", click, true);
            source.diagnostic = undefined;
            source.traceTileSelection = undefined;
            gpu?.dispose();
            marker.remove();
            overlay.remove();
            panel.remove();
            launch.remove();
        }
    };
}
module.exports = { setupDiagnostics };
