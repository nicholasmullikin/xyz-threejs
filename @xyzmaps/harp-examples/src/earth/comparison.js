// North-up Mercator reference registered to the Santa Barbara coastline.
const reference = require("./terrain-reference");
const circumference = 2 * Math.PI * 6378137;
const groundWidth =
    (circumference *
        Math.cos((reference.latitude * Math.PI) / 180) *
        (reference.east - reference.west)) /
    360;

function createComparison({ map, root, bar, button, element, setMode, getMode, getSunHour, closePanel }) {
    const trigger = button(bar, "Layers", open);
    trigger.setAttribute("aria-expanded", "false");
    const panel = element("div", root, "earth-compare");
    panel.hidden = true;
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "Compare map layers");
    const label = element("label", panel, "", "Layer");
    const select = element("select", panel);
    select.id = label.htmlFor = "earth-compare-layer";
    function option(value, title) {
        const el = element("option", select, "", title);
        el.value = value;
    }
    option("a", "Our satellite");
    option("c", "Our shaded terrain");
    const apiKey = new URLSearchParams(location.search).get("google_maps_key");
    if (apiKey) option("live", "Google terrain · live");
    option("reference", "Google terrain · Santa Barbara screenshot");
    const { sources } = require("./open-imagery");
    const params = new URLSearchParams(location.search);
    const selected = sources[params.get("imagery")] ? params.get("imagery") : "";
    const caption = element("label", panel, "", "Imagery");
    const imagery = element("select", panel);
    imagery.id = caption.htmlFor = "earth-imagery-source";
    for (const [value, text] of [["", "Default satellite"], ...Object.entries(sources).map(([id, source]) => [id, source.name])]) {
        const opt = element("option", imagery, "", text);
        opt.value = value;
    }
    imagery.value = selected;
    function loadImagery(id, example = false) {
        const { latitude, longitude, altitude } = map.target;
        const pose = example ? sources[id].example :
            [latitude, longitude, altitude ?? 0, map.targetDistance, map.tilt, map.heading];
        const sun = example ? (12 + (-112.15 - pose[1]) / 15 + 24) % 24 : getSunHour();
        function apply(url) {
            if (id) url.searchParams.set("imagery", id);
            else url.searchParams.delete("imagery");
            url.searchParams.set("view", pose.join(","));
            url.searchParams.set("sun", String(sun));
            url.searchParams.delete("layer");
        }
        const url = new URL(location.href);
        apply(url);
        url.searchParams.set("compare", "1");
        // Share the public view through the blog URL without copying iframe credentials.
        if (window.parent !== window && document.referrer && new URL(document.referrer).origin === location.origin) {
            const outer = new URL(window.parent.location.href);
            if (outer.pathname.replace(/\/$/, "") === "/blog/earth") {
                apply(outer);
                window.parent.history.replaceState(window.parent.history.state, "", outer);
            }
        }
        location.replace(url);
    }
    imagery.onchange = () => loadImagery(imagery.value);
    if (selected) button(panel, "View " + sources[selected].place, () => loadImagery(selected, true));
    const link = element("a", panel, "", "Open live Google Terrain ↗");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    button(panel, "Done", finish);
    const surface = element("div", root, "earth-compare-surface");
    surface.hidden = true;
    const attribution = element(
        "small",
        root,
        "earth-reference-credit",
        "Google Maps · supplied screenshot"
    );
    attribution.hidden = true;
    const live = element("div", surface, "earth-compare-live");
    const message = element("span", surface, "earth-compare-message");
    message.setAttribute("role", "status");
    let current = "",
        googleMap,
        loading,
        disposed = false;
    function camera() {
        const { latitude, longitude } = map.target;
        const zoom = Math.log2(
            (circumference * Math.cos((latitude * Math.PI) / 180)) / (256 * map.pixelToWorld)
        );
        return { lat: latitude, lng: longitude, zoom: Math.min(21, Math.max(0, zoom)) };
    }
    function updateLink() {
        const center = current === "live" && googleMap && googleMap.getCenter();
        const view = center ? { ...center.toJSON(), zoom: googleMap.getZoom() } : camera();
        link.href =
            "https://www.google.com/maps/@?" +
            new URLSearchParams({
                api: "1",
                map_action: "map",
                basemap: "terrain",
                center: view.lat + "," + view.lng,
                zoom: String(Math.round(view.zoom))
            });
    }
    function frameReference() {
        if (current !== "reference") return;
        const scale = Math.min(
            map.canvas.clientWidth / reference.width,
            map.canvas.clientHeight / reference.height
        );
        const distance = (map.focalLength * groundWidth) / (reference.width * scale);
        map.lookAt({
            target: { latitude: reference.latitude, longitude: reference.longitude, altitude: 0 },
            distance,
            tilt: 0,
            heading: 0
        });
    }
    async function showLive() {
        message.textContent = "Loading Google Terrain…";
        try {
            if (!loading)
                loading = new Promise((resolve, reject) => {
                    const script = document.createElement("script");
                    script.src =
                        "https://maps.googleapis.com/maps/api/js?" +
                        new URLSearchParams({ key: apiKey, v: "weekly" });
                    script.onload = resolve;
                    script.onerror = () => {
                        script.remove();
                        reject(new Error("Google Maps could not load"));
                    };
                    document.head.appendChild(script);
                }).catch(error => {
                    loading = undefined;
                    throw error;
                });
            await loading;
            if (disposed || current !== "live") return;
            const { lat, lng, zoom } = camera();
            if (!googleMap)
                googleMap = new window.google.maps.Map(live, {
                    mapTypeId: "terrain",
                    mapTypeControl: false,
                    streetViewControl: false,
                    fullscreenControl: false,
                    gestureHandling: "greedy"
                });
            googleMap.setCenter({ lat, lng });
            googleMap.setZoom(Math.round(zoom));
            message.textContent = "";
        } catch {
            if (!disposed && current === "live")
                message.textContent =
                    "Google Terrain is unavailable here. Use the live link above.";
        }
    }
    let visibleFps;
    function change(value) {
        if (current === "live" && googleMap?.getCenter()) {
            const { lat, lng } = googleMap.getCenter().toJSON();
            const metersPerPixel =
                (circumference * Math.cos((lat * Math.PI) / 180)) /
                (256 * 2 ** googleMap.getZoom());
            map.lookAt({
                target: { latitude: lat, longitude: lng },
                distance: map.focalLength * metersPerPixel,
                heading: 0,
                tilt: 0
            });
        }
        current = select.value = value;
        surface.hidden = value !== "live";
        root.classList.toggle("earth-show-reference", !surface.hidden);
        if (!surface.hidden && visibleFps === undefined) {
            visibleFps = map.maxFps;
            map.maxFps = visibleFps > 0 ? Math.min(2, visibleFps) : 2;
        } else if (surface.hidden && visibleFps !== undefined) {
            map.maxFps = visibleFps;
            visibleFps = undefined;
        }
        live.hidden = value !== "live";
        attribution.hidden = value !== "reference";
        message.textContent = "";
        if (value === "reference") {
            const target = map.target;
            if (
                target.latitude < reference.south ||
                target.latitude > reference.north ||
                target.longitude < reference.west ||
                target.longitude > reference.east
            )
                frameReference();
            setMode(value);
        } else if (value === "live") showLive();
        else setMode(value);
        updateLink();
    }
    function open() {
        closePanel();
        bar.hidden = true;
        panel.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        change(getMode());
        select.focus();
    }
    function finish() {
        change(getMode());
        current = "";
        panel.hidden = true;
        bar.hidden = false;
        trigger.setAttribute("aria-expanded", "false");
        trigger.focus();
    }
    select.onchange = () => change(select.value);
    link.onfocus = link.onpointerdown = link.onclick = updateLink;
    const keydown = event => {
        if (panel.hidden) return;
        if (event.key === "Escape") {
            event.preventDefault();
            finish();
        }
        if (!surface.hidden && ["1", "2", "c", "+", "-", "="].includes(event.key))
            event.stopImmediatePropagation();
    };

    window.addEventListener("keydown", keydown, true);

    if (params.get("compare") === "1") queueMicrotask(open);
    return {
        syncMode(value) {
            if (!panel.hidden && surface.hidden) current = select.value = value;
            attribution.hidden = value !== "reference" || !surface.hidden;
        },
        dispose() {
            disposed = true;

            if (visibleFps !== undefined) map.maxFps = visibleFps;
            window.removeEventListener("keydown", keydown, true);
            if (googleMap) window.google.maps.event.clearInstanceListeners(googleMap);
        }
    };
}
module.exports = { createComparison };
