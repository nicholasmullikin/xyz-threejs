const { transform } = require("./math");
const { sourceLevel } = require("./imagery-provider");
const { createCoverage, selectPages, selectBase } = require("./imagery-coverage");
const { screenVelocity } = require("./imagery-motion");
const { DETAIL_SLOTS } = require("./terrain-shaders");
const PLAN_MS = 160,
    FADE_MS = 280;
// A 512px RGBA8 page plus all mip levels costs 1,398,100 bytes. The
// default 96 MiB working set holds 72 pages, of which 22 remain available
// for parents, outgoing fades and recent views.
function pageBudgets(bytes, count, bytesPerPage=1398100, survey = false) {
    const resident = Math.min(count, Math.floor(bytes / bytesPerPage));
    const scale = Math.min(survey ? 2 : 1, Math.max(0, resident / 72));
    return { baseLimit: Math.max(1, Math.floor(38 * scale)), pageLimit: Math.floor(12 * scale) };
}

function splitPageBudget(budget, samples) {
    if (budget.baseLimit >= 38) return budget;
    // Use effective coverage, not the raw count of tiny visible fragments:
    // one foreground mesh can fill most of the display with twenty equally
    // small skyline meshes in the remaining strip.
    const counts = new Map();
    let sumSquares = 0;
    for (const sample of samples) {
        const count = counts.get(sample.tile) || 0;
        sumSquares += 2 * count + 1;
        counts.set(sample.tile, count + 1);
    }
    const meshes = sumSquares ? Math.ceil(samples.length ** 2 / sumSquares) : 0;
    const total = budget.baseLimit + budget.pageLimit;
    const spare = Math.max(0, budget.baseLimit - meshes - 4);
    const pageLimit = Math.min(12, Math.floor(total / 2), budget.pageLimit + spare);
    return { baseLimit: total - pageLimit, pageLimit };
}

function createRefinement(THREE, map, options, lifetime, stats, budget, satellite, residentBudget) {
    const openSource = require("./open-imagery").sources[options.openImagery];
    const units = map.renderer.capabilities.maxTextures;
    const dedicated = units - 8 - (units >= 12 ? 1 : 0) - (units >= 16 ? 1 : 0);
    const detailSupported = satellite && !options.orbital && !globalThis.navigator?.connection?.saveData;
    // An opaque base page can use its own sampler for the fallback panorama.
    // Near the ground this releases the regional bathymetry sampler, even on
    // WebGL1 hardware with only eight fragment texture units. Transparent
    // open imagery still needs the separate panorama below its missing pixels.
    const shareOverview = detailSupported && dedicated < 2 && !options.openImagery;
    const available = dedicated + Number(shareOverview);
    const slots = detailSupported ? Math.max(0, Math.min(DETAIL_SLOTS, available)) : 0;
    const capacityFor = extras => Math.max(0,Math.min(slots,available-Number(extras)));
    const roadSlots=capacityFor(1);
    let activeSlots = slots;
    const anisotropy = Math.max(1, Math.min(2, map.renderer.capabilities.getMaxAnisotropy()));
    const sample = createCoverage(THREE);
    const previousCamera = new THREE.Matrix4(),
        previousProjection = new THREE.Matrix4(),
        previousClipFromEye = new THREE.Matrix4();
    let plannedTopology = -1,
        width = 0,
        height = 0,
        last = -Infinity,
        wake = false,
        lastMode,
        previouslyRegional,
        previousFootprint;
    let drawSource,
        drawRevision = -1,
        drawPlan;
    let plan = { tiles: new Map(), selected: new Map(), base: new Map() };

    function update(rendered, mode, now, topology, extraSamplers = 0, regional = false) {
        const capacity=capacityFor(extraSamplers);
        const camera = map.camera;
        const geometryChanged = plannedTopology !== topology;
        const cameraChanged =
            !previousCamera.equals(camera.matrixWorldInverse) ||
            !previousProjection.equals(camera.projectionMatrix) ||
            width !== map.canvas.width ||
            height !== map.canvas.height;
        const nextBudget=residentBudget?.();
        const budgetChanged=nextBudget && (nextBudget.baseLimit!==budget.baseLimit || nextBudget.pageLimit!==budget.pageLimit);
        const footprint =
            capacity && mode === "a" && map.zoomLevel >= 12 && !map.cameraIsMoving ? anisotropy : 1;
        if (
            capacity === activeSlots &&
            !budgetChanged &&
            !geometryChanged &&
            !cameraChanged &&
            mode === lastMode &&
            footprint === previousFootprint &&
            regional === previouslyRegional
        )
            return;
        if (now < last + PLAN_MS && mode === lastMode && capacity === activeSlots && regional === previouslyRegional) {
            if (!wake) {
                wake = true;
                lifetime.timeout(
                    () => {
                        wake = false;
                        map.update();
                    },
                    last + PLAN_MS - now
                );
            }
            return;
        }
        const start = performance.now();
        if(budgetChanged)budget=nextBudget;
        activeSlots = capacity;
        plannedTopology = topology;
        const elapsed = now - last;
        width = map.canvas.width;
        height = map.canvas.height;
        previousFootprint = footprint;
        const samples = !satellite && mode === "a" ? [] : sample(map, rendered.values(), footprint);
        previousClipFromEye
            .multiplyMatrices(previousProjection, previousCamera)
            .multiply(camera.matrixWorld);
        const velocity = screenVelocity(
            samples,
            previousClipFromEye,
            camera.projectionMatrix,
            width / Math.max(1, height),
            elapsed
        );
        previousProjection.copy(camera.projectionMatrix);
        previousCamera.copy(camera.matrixWorldInverse);
        last = now;
        lastMode = mode;
        previouslyRegional = regional;
        stats.screenVelocity = velocity;
        stats.feedbackRuns++;
        if (mode !== "a") for (const s of samples) s.z = Math.min(19, s.z + 1);
        else if (openSource) {
            const offset = Math.log2(512 / openSource.tileSize);
            for (const s of samples) s.z = Math.min(openSource.maxZoom, s.z + offset);
        }
        // Only nearby views benefit from independent pages. The base working
        // set still accounts for all visible branches and their screen area.
        const detailMinZoom = openSource && !map.cameraIsMoving ? openSource.minZoom : 13;
        const enabled = activeSlots && mode === "a" && map.zoomLevel >= detailMinZoom && !(shareOverview && regional);
        const cover = enabled ? splitPageBudget(budget, samples) : budget;
        const previousBase = plan.base;
        plan = selectPages(
            samples,
            enabled ? activeSlots : 0,
            enabled ? cover.pageLimit : 0,
            plan.selected
        );
        plan.pageLimit = cover.pageLimit;
        plan.base = selectBase(rendered.values(), plan.tiles, cover.baseLimit, previousBase);
        plan.samples = samples;
        plan.gridCells =
            24 * Math.max(6, Math.min(32, Math.round((24 * height) / Math.max(1, width))));
        stats.feedbackSamples = samples.length;
        stats.feedbackMs = performance.now() - start;
        stats.detailWanted = plan.selected.size;
        return true;
    }
    function residentPages(cache, revision) {
        if (!activeSlots || !plan.selected.size) return undefined;
        if (drawSource !== plan || drawRevision !== revision) {
            drawPlan = selectPages(plan.samples, activeSlots, plan.pageLimit, drawPlan?.selected, cache);
            drawSource = plan;
            drawRevision = revision;
        }
        return drawPlan.tiles;
    }
    function uniforms(neutral) {
        const result = {};
        for (let i = 0; i < slots; i++) {
            result["detailMap" + i] = { value: neutral };
            result["detailUv" + i] = { value: new THREE.Vector4() };
            result["detailEdges" + i] = { value: new THREE.Vector4(1, 1, 1, 1) };
            result["detailFade" + i] = { value: 0 };
        }
        return result;
    }
    function bind(state, pages, mode, cache, pinned, neutral, now, planned) {
        if (!slots) return false;
        const u = state.material.uniforms;
        const active = state.details || (state.details = []);
        // A reused material can still have the outgoing cut's pages bound.
        // Slots are packed from zero, so the first sampler identifies an empty draw.
        if (!active.length && !pages?.length && u.detailMap0.value === neutral) return false;
        const wanted = pages || [];
        const elapsed = Math.min(1, Math.max(0, now - (state.detailTime ?? now)) / FADE_MS);
        state.detailTime = now;
        let fading = false;
        // Retiring pages keep their slots (and cache pin) through the fade.
        for (let i = active.length - 1; i >= 0; i--) {
            const page = active[i];
            if (mode !== "a") {
                active.splice(i, 1);
                continue;
            }
            const target = planned ? Number(wanted.some(p => p.key === page.entry.key)) : page.alpha;
            if (active.length > activeSlots || (!target && page.alpha <= elapsed)) {
                active.splice(i, 1);
                continue;
            }
            page.alpha +=
                Math.sign(target - page.alpha) * Math.min(elapsed, Math.abs(target - page.alpha));
            if (page.alpha !== target) fading = true;
        }
        for (const page of wanted) {
            if (mode !== "a" || active.length === activeSlots) break;
            const entry = cache.get(page.key);
            if (!entry || active.some(p => p.entry === entry)) continue;
            active.push({ entry, alpha: 0, uv: transform(state.tile, entry) });
            fading = true;
        }
        active.sort((a, b) => a.entry.z - b.entry.z);
        for (let i = 0; i < slots; i++) {
            const page = active[i];
            u["detailMap" + i].value = page?.entry.texture || neutral;
            u["detailFade" + i].value = page ? page.alpha * page.alpha * (3 - 2 * page.alpha) : 0;
            if (!page) continue;
            if (i === 0 && shareOverview) {
                if (previouslyRegional) u.detailFade0.value = 0;
                else u.earthMap.value = page.entry.texture;
            }
            u["detailUv" + i].value.fromArray(page.uv);
            pinned.add(page.entry.key);
            page.entry.last = now;
            if (page.alpha > 0) {
                stats.detailBindings++;
                stats.detailHighestZoom = Math.max(stats.detailHighestZoom, page.entry.z);
            }
        }
        return fading;
    }
    function updateEdges(states) {
        if (!slots || !stats.detailBindings) return;
        const drawn = new Map();
        let maxLevel = 0;
        for (const state of states) {
            const t = state.tile;
            const n = 2 ** t.z;
            drawn.set(n * (n + t.y) + t.x, state);
            maxLevel = Math.max(maxLevel, t.z);
        }
        function levelAt(mx, my) {
            mx = ((mx % 1) + 1) % 1;
            if (my < 0 || my >= 1) return 2;
            for (let z = maxLevel; z >= 0; z--) {
                const n = 2 ** z,
                    state = drawn.get(n * (n + Math.floor(my * n)) + Math.floor(mx * n));
                if (!state) continue;
                let level =
                    Math.max(2, sourceLevel(state.from.entry)) * (1 - state.mix) +
                    Math.max(2, sourceLevel(state.to.entry)) * state.mix;
                for (const patch of state.details || []) {
                    const e = patch.entry,
                        n = 2 ** e.z;
                    if (Math.floor(mx * n) === e.x && Math.floor(my * n) === e.y)
                        level = Math.max(level, level + (e.z - level) * patch.alpha);
                }
                return level;
            }
            return 2;
        }
        for (const state of states) {
            const pages = state.details || [];
            for (let i = 0; i < pages.length; i++) {
                const entry = pages[i].entry;
                let base = Math.max(
                    2,
                    sourceLevel(state.mix > 0.5 ? state.to.entry : state.from.entry)
                );
                // A nested detail page can feather into its already-loaded
                // intermediate parent instead of the coarse terrain image.
                for (let j = 0; j < i; j++) {
                    const coarse = pages[j].entry,
                        scale = 2 ** (entry.z - coarse.z);
                    if (
                        pages[j].alpha > 0.5 &&
                        Math.floor(entry.x / scale) === coarse.x &&
                        Math.floor(entry.y / scale) === coarse.y
                    )
                        base = Math.max(base, coarse.z);
                }
                const n = 2 ** entry.z;
                const side = (horizontal, constant) => {
                    const at = v =>
                        levelAt(
                            (entry.x + (horizontal ? v : constant)) / n,
                            (entry.y + (horizontal ? constant : v)) / n
                        );
                    const a = at(0.2),
                        b = at(0.5),
                        c = at(0.8);
                    const neighbour = a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
                    return detailEdgeGap(entry.z, base, neighbour);
                };
                state.material.uniforms["detailEdges" + i].value.set(
                    side(false, -0.0001),
                    side(false, 1.0001),
                    side(true, -0.0001),
                    side(true, 1.0001)
                );
            }
        }
    }
    return {
        slots,
        shareOverview,
        get activeSlots() { return activeSlots; },
        roadSlots,capacityFor,
        residentPages,
        updateEdges,
        dispose() {
            drawPlan = drawSource = undefined;
            plan = { tiles: new Map(), selected: new Map(), base: new Map() };
        },
        update,
        uniforms,
        bind,
        get plan() {
            return plan;
        }
    };
}
// If the adjacent page is itself much sharper than the underlying image,
// fully fading to that old base would paint a blurred stripe between two
// otherwise detailed pages. Only fade fully at an actual coverage frontier.
function detailEdgeGap(level, base, neighbour) {
    const gap = Math.max(0, level - neighbour);
    if (gap < 0.25) return 0;
    if (neighbour <= base + 0.5) return Math.max(1, level - base);
    return Math.min(0.8, gap / Math.max(1, level - base));
}
module.exports = { createRefinement, detailEdgeGap, pageBudgets, splitPageBudget };
