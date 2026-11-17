function createControls({ map, setSunHour, environment, buildings, getSunHour, togglePlaying }) {
    const style = document.createElement("style");
    style.textContent = require("./controls-style");
    document.head.appendChild(style);
    const root = document.createElement("div");
    root.id = "earth-controls";
    const icons = {
        earth: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
        explore: '<path d="m16 8-2 6-6 2 2-6Z"/><circle cx="12" cy="12" r="9"/>',
        environment:
            '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
        close: '<path d="m6 6 12 12M6 18 18 6"/>',
        expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
        collapse: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5"/>',
        play: '<path d="m9 5 11 7-11 7Z"/>',
        pause: '<path d="M8 5v14M16 5v14"/>'
    };
    const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
    const element = (tag, parent, className, text) => {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text) el.textContent = text;
        parent.appendChild(el);
        return el;
    };
    const button = (parent, label, fn, glyph) => {
        const b = element("button", parent);
        b.type = "button";
        if (glyph) b.innerHTML = icon(glyph);
        element("span", b, "", label);
        b.onclick = fn;
        return b;
    };
    const bar = element("nav", root, "earth-bar");
    bar.setAttribute("aria-label", "Earth map");
    const home = button(
        bar,
        "Earth",
        () => {
            closePanel();
            map.lookAt({
                target: { latitude: 23, longitude: -95 },
                zoomLevel: 2.4,
                tilt: 0,
                heading: 0
            });
        },
        "earth"
    );
    home.className = "earth-home";
    home.title = "View the whole Earth";
    home.setAttribute("aria-label", "Earth");
    let active = null;
    const panels = {};
    function closePanel(restore = false) {
        if (!active) return;
        const item = panels[active];
        item.drawer.hidden = true;
        item.trigger.setAttribute("aria-expanded", "false");
        active = null;
        if (restore) item.trigger.focus();
    }
    function makePanel(name, glyph) {
        const trigger = button(
            bar,
            name,
            () => {
                if (active === name) {
                    closePanel();
                    return;
                }
                closePanel();
                active = name;
                drawer.hidden = false;
                trigger.setAttribute("aria-expanded", "true");
            },
            glyph
        );
        const drawer = element("div", root, "earth-drawer");
        drawer.id = "earth-panel-" + name.toLowerCase();
        drawer.hidden = true;
        drawer.setAttribute("role", "region");
        drawer.setAttribute("aria-label", name);
        trigger.setAttribute("aria-controls", drawer.id);
        trigger.setAttribute("aria-expanded", "false");
        const heading = element("div", drawer, "earth-heading");
        element("h2", heading, "", name);
        const close = button(heading, "", () => closePanel(true), "close");
        close.setAttribute("aria-label", "Close " + name.toLowerCase());
        panels[name] = { trigger, drawer };
        return drawer;
    }
    const explore = makePanel("Explore", "explore"),
        settings = makePanel("Environment", "environment");
    const section = (parent, title) => {
        const s = element("section", parent);
        element("h3", s, "", title);
        return s;
    };
    const destinations = element("div", section(explore, "Landscapes"), "earth-destinations");
    function destination(name, description, fn) {
        const b = button(destinations, name, () => {
            fn();
            closePanel();
        });
        b.className = "earth-destination";
        element("small", b, "", description);
        b.setAttribute("aria-label", name);
    }
    destination("Canyon", "Arizona, USA", () => {
        setSunHour(14);
        map.lookAt({
            target: { latitude: 36.1, longitude: -112.15, altitude: 1600 },
            zoomLevel: 10.5,
            tilt: 65,
            heading: 28
        });
    });
    destination("Himalayas", "Everest region", () => {
        setSunHour(2);
        map.lookAt({
            target: { latitude: 27.9, longitude: 86.8, altitude: 4800 },
            zoomLevel: 9.5,
            tilt: 76,
            heading: 0
        });
    });
    destination("Sky", "Clouds over the Pacific", () => {
        setSunHour(12.8567);
        environment.setCloudPreset(9);
        cloudTypes.value = "9";
        setCloudEnabled(true);
        map.lookAt({
            target: { latitude: 35, longitude: -125, altitude: 0 },
            distance: 18000,
            tilt: 88,
            heading: 0
        });
    });
    const cityViews = {
        "New York": [40.754, -73.985, 15],
        Boston: [42.357, -71.058, 15],
        London: [51.513, -0.088, 20],
        Tokyo: [35.681, 139.767, 15]
    };
    function select(parent, label, options, change) {
        const field = element("div", parent, "earth-field"),
            id = "earth-" + label.toLowerCase().replaceAll(" ", "-");
        const caption = element("label", field, "", label);
        caption.htmlFor = id;
        const el = element("select", field);
        el.id = id;
        for (const [value, text] of options) {
            const opt = element("option", el, "", text);
            opt.value = value;
        }
        el.onchange = () => change(el.value);
        return el;
    }
    const cities = select(
        section(explore, "Cities"),
        "Visit a city",
        [["", "Choose a city"], ...Object.keys(cityViews).map(n => [n, n])],
        name => {
            if (!cityViews[name]) return;
            const [latitude, longitude, altitude] = cityViews[name];
            setSunHour((((12 + (-112.15 - longitude) / 15) % 24) + 24) % 24);
            map.lookAt({
                target: { latitude, longitude, altitude },
                zoomLevel: 15.5,
                tilt: 58,
                heading: 15
            });
            cities.value = "";
            closePanel();
        }
    );
    element("div", explore, "earth-help", "Drag to explore · Scroll to zoom · Right-drag to tilt");
    const sunSection = section(settings, "Daylight"),
        sunRow = element("div", sunSection, "earth-row");
    const sunLabel = element("label", sunRow, "", "Solar time at view");
    sunLabel.htmlFor = "earth-sun";
    const output = element("output", sunRow);
    output.setAttribute("for", "earth-sun");
    const slider = element("input", sunSection);
    slider.id = "earth-sun";
    slider.type = "range";
    slider.min = "0";
    slider.max = "24";
    slider.step = ".1";
    slider.setAttribute("aria-label", "Sun position over the day");
    const localHour = hour => (((hour + (map.target.longitude + 112.15) / 15) % 24) + 24) % 24;
    const solarLabel = hour => {
        const minutes = Math.round(localHour(hour) * 60) % 1440;
        return (
            String(Math.floor(minutes / 60)).padStart(2, "0") +
            ":" +
            String(minutes % 60).padStart(2, "0")
        );
    };
    function updateSun(hour) {
        slider.value = String(localHour(hour));
        output.value = solarLabel(hour);
        slider.setAttribute("aria-valuetext", output.value + " solar time");
    }
    slider.oninput = () =>
        setSunHour(
            (((Number(slider.value) + (-112.15 - map.target.longitude) / 15) % 24) + 24) % 24
        );
    const actions = element("div", sunSection, "earth-sun-actions");
    for (const [name, hour] of [
        ["Day", 12],
        ["Night", 0]
    ])
        button(actions, name, () =>
            setSunHour((((hour + (-112.15 - map.target.longitude) / 15) % 24) + 24) % 24)
        );
    const play = button(
        actions,
        "Animate",
        () => {
            const playing = togglePlaying();
            play.innerHTML =
                icon(playing ? "pause" : "play") + `<span>${playing ? "Pause" : "Animate"}</span>`;
            play.setAttribute(
                "aria-label",
                playing ? "Pause daylight cycle" : "Animate daylight cycle"
            );
            play.setAttribute("aria-pressed", String(playing));
            map.update();
        },
        "play"
    );
    play.setAttribute("aria-label", "Animate daylight cycle");
    play.setAttribute("aria-pressed", "false");
    function toggle(parent, name, description, setter) {
        const row = element("div", parent, "earth-row earth-switch-row"),
            copy = element("span", row);
        element("span", copy, "", name);
        if (description) element("small", copy, "", description);
        const b = button(row, "", () => set(b.getAttribute("aria-pressed") !== "true"));
        b.className = "earth-switch";
        b.setAttribute("aria-label", name);
        b.setAttribute("aria-pressed", "true");
        function set(on) {
            b.setAttribute("aria-pressed", String(on));
            setter(on);
        }
        return set;
    }
    const weather = section(settings, "Weather");
    const setCloudEnabled = toggle(weather, "Clouds", null, on => {
        environment.setClouds(on);
        cloudTypes.disabled = !on;
        quality.disabled = !on;
    });
    const cloudFields = element("div", weather);
    cloudFields.style.marginTop = "14px";
    const cloudTypes = select(
        cloudFields,
        "Cloud type",
        environment.cloudPresets.map(p => [
            String(p.id),
            p.id === 0 ? "Automatic weather" : p.name
        ]),
        environment.setCloudPreset
    );
    const quality = select(
        cloudFields,
        "Cloud quality",
        [
            ["low", "Fast"],
            ["balanced", "Balanced"],
            ["high", "Detailed"]
        ],
        environment.setCloudQuality
    );
    quality.value = "balanced";
    const layers = section(settings, "On the ground");
    toggle(layers, "Lights", "City lights after sunset", environment.setLights);
    toggle(layers, "Buildings", "3D buildings at street scale", buildings.setEnabled);
    element("div", settings, "earth-help", "Weather and daylight are simulated.");
    const fullscreen = button(
        root,
        "",
        async () => {
            try {
                if (document.fullscreenElement) await document.exitFullscreen();
                else await document.documentElement.requestFullscreen();
            } catch {
                status.hidden = false;
                status.textContent =
                    "Fullscreen is unavailable here. Open the demo in its own tab.";
            }
        },
        "expand"
    );
    fullscreen.className = "earth-fullscreen";
    const status = element("div", root, "earth-status");
    status.setAttribute("role", "status");
    status.hidden = true;
    function updateFullscreen() {
        const on = !!document.fullscreenElement;
        fullscreen.innerHTML = icon(on ? "collapse" : "expand");
        fullscreen.setAttribute("aria-label", on ? "Exit fullscreen" : "Fullscreen");
        fullscreen.title = on ? "Exit fullscreen (Esc)" : "Fullscreen";
        fullscreen.setAttribute("aria-pressed", String(on));
        map.resize(innerWidth, innerHeight);
    }
    fullscreen.hidden = !document.fullscreenEnabled;
    document.addEventListener("fullscreenchange", updateFullscreen);
    updateFullscreen();
    const dismiss = e => {
        if (active && !panels[active].drawer.contains(e.target) && !bar.contains(e.target))
            closePanel();
    };
    const keydown = e => {
        if (e.key === "Escape" && active) {
            e.preventDefault();
            closePanel(true);
        }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    root.addEventListener("pointerdown", e => e.stopPropagation());
    root.addEventListener("wheel", e => e.stopPropagation());
    root.addEventListener("keydown", e => {
        if (e.key === "Escape") keydown(e);
        e.stopPropagation();
    });
    document.body.appendChild(root);
    const refreshSun = () => updateSun(getSunHour());
    map.addEventListener("didrender", refreshSun);
    updateSun(getSunHour());
    const credits = document.createElement("details");
    credits.id = "earth-credits";
    credits.innerHTML =
        '<summary style="cursor:pointer">© OpenStreetMap · Mapbox · NASA</summary><div>Buildings: <a href="https://openfreemap.org/" target="_blank" rel="noopener">OpenFreeMap</a> / <a href="https://openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> (ODbL). Heights vary with available data.<br>Satellite / terrain: © Mapbox. Night lights: NASA Black Marble (2016). Clouds: procedural volumes with NASA Blue Marble coverage; simulated weather. Window lighting is illustrative. <a href="resources/earth/credits.html" target="_blank" rel="noopener">Sources</a></div>';
    document.body.appendChild(credits);
    return {
        updateSun,
        dispose() {
            document.removeEventListener("fullscreenchange", updateFullscreen);
            document.removeEventListener("pointerdown", dismiss);
            document.removeEventListener("keydown", keydown);
            map.removeEventListener("didrender", refreshSun);
            root.remove();
            credits.remove();
            style.remove();
        }
    };
}
module.exports = { createControls };
