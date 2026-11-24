// The spherical terrain source has a single, unwrapped quadtree. Reserve a
// drawable ancestor for every branch before spending the remaining slots on detail.
function selectTerrainTiles(
    nearestFirst,
    limit,
    focus,
    visibleShare,
    survey = false,
    previousSplits
) {
    if (limit <= 0) return [];
    if (nearestFirst.length <= limit) return nearestFirst;
    const nodes = new Map();
    function insert(key, leaf) {
        const code = key.mortonCode();
        if (nodes.has(code)) return nodes.get(code);
        const node = { entry: { ...leaf, tileKey: key }, children: [], weight: 0 };
        nodes.set(code, node);
        if (key.level > 0) insert(key.parent(), leaf).children.push(node);
        return node;
    }
    const fx = focus ? (focus.longitude + 180) / 360 : 0;
    const fy = focus
        ? (1 - Math.asinh(Math.tan((focus.latitude * Math.PI) / 180)) / Math.PI) / 2
        : 0;
    // Shares from projected bounds and rendered terrain rays have different scales.
    // Normalize the bounds before mixing them, retaining coverage of thin silhouettes.
    const areaOf = leaf => Math.min(1, Math.max(0.0001, leaf.area || 0));
    const totalArea = focus ? nearestFirst.reduce((sum, leaf) => sum + areaOf(leaf), 0) : 1;
    const sampleFraction = visibleShare ? (survey ? 0.4 : 0.25) : 0;
    for (const leaf of nearestFirst) {
        const key = leaf.tileKey,
            node = insert(key, leaf);
        if (focus) {
            const n = 2 ** key.level;
            const x = Math.abs(fx * n - key.column - 0.5);
            const distance = Math.max(
                0,
                Math.hypot(Math.min(x, n - x), fy * n - key.row - 0.5) - 0.7
            );
            // Distance from the target to the actual tile rectangle, in world
            // coordinates so mixed-level candidates remain comparable.
            const dx = Math.max(0, Math.min(x, n - x) - 0.5);
            const dy = Math.max(0, Math.abs(fy * n - key.row - 0.5) - 0.5);
            node.focusDistance = (dx * dx + dy * dy) / (n * n);
            const footprint = areaOf(leaf) / totalArea;
            const observed = visibleShare ? visibleShare(key) : 0;
            node.weight =
                ((1 - sampleFraction) * footprint + sampleFraction * observed) *
                (1 + 5 / (1 + distance * distance));
        }
    }
    const root = nodes.get(1),
        selected = new Set([root]);
    const branches = [...nodes.values()].filter(node => node.children.length);
    function refine(budget) {
        for (const node of branches) {
            if (!selected.has(node) || selected.size - 1 + node.children.length > budget) continue;
            selected.delete(node);
            for (const child of node.children) selected.add(child);
        }
    }
    // Reserve the first few refinement paths for the foreground. On a grazing
    // view hundreds of thin horizon branches otherwise exhaust the budget before
    // the tile under the camera target gets even one of its final splits.
    if (focus) {
        const foreground = nearestFirst
            .map(e => nodes.get(e.tileKey.mortonCode()))
            .filter(node => node.entry.tileKey.level >= 13)
            .sort((a, b) => a.focusDistance - b.focusDistance || b.weight - a.weight);
        const reserved = Math.floor(limit * 0.38);
        for (const leaf of foreground.slice(0, 9)) {
            const path = [];
            let node = leaf;
            while (node.entry.tileKey.level > 0 && !selected.has(node)) {
                node = nodes.get(node.entry.tileKey.parent().mortonCode());
                path.push(node);
            }
            if (!selected.has(node)) continue;
            const cost = path.reduce((n, b) => n + b.children.length - 1, 0);
            if (selected.size + cost > reserved) continue;
            for (const branch of path.reverse()) {
                selected.delete(branch);
                for (const child of branch.children) selected.add(child);
            }
        }
    }
    // Keep a broad disjoint cover. Local survey data adds two levels of
    // descendants; reserve part of the same budget for their projected extent
    // near the camera target so distant branches cannot consume every slot.
    branches.sort((a, b) => a.entry.tileKey.level - b.entry.tileKey.level);
    // Oblique views can exhaust the cover with distant terrain even on a
    // desktop. Reserve room for the foreground at every device budget.
    const broadFraction = survey ? 0.7 : 0.6;
    refine(focus ? Math.max(1, Math.floor(broadFraction * limit)) : limit);
    if (focus) {
        for (let i = branches.length - 1; i >= 0; i--)
            for (const child of branches[i].children) branches[i].weight += child.weight;
        // Favor the current cut for near ties. Rank only available splits so a
        // descendant never loses its turn because its parent was visited later.
        const score = node =>
            (node.weight * (previousSplits?.has(node.entry.tileKey.mortonCode()) ? 1.35 : 1)) /
            Math.max(1, node.children.length - 1);
        const ranked = branches
            .map(node => ({ node, score: score(node) }))
            .sort(
                (a, b) =>
                    b.score - a.score || a.node.entry.tileKey.level - b.node.entry.tileKey.level
            );
        let changed;
        do {
            changed = false;
            for (const { node } of ranked) {
                if (!selected.has(node) || selected.size + node.children.length - 1 > limit)
                    continue;
                selected.delete(node);
                for (const child of node.children) selected.add(child);
                changed = true;
            }
        } while (changed);
    }
    return [...selected].map(node => node.entry).sort((a, b) => a.distance - b.distance);
}
module.exports = { selectTerrainTiles };

// An opaque terrain surface needs a nonoverlapping draw cover and an
// independent set of requests for regions that will benefit from more detail.
// A cold camera jump starts a few broad patches before it queues close detail.
function planTerrainTiles(
    desired,
    state,
    previous,
    limit = 12,
    selectRequests,
    focus,
    screenArea,
    detailBase = Infinity,
    openingTiles
) {
    if (desired.every(entry => state(entry.tileKey, 0) === "ready")) {
        return { requests: desired, rendered: desired, retain: [], complete: true };
    }
    const nodes = new Map(),
        bootstrap = new Set();
    function insert(key, entry) {
        const id = key.mortonCode();
        let node = nodes.get(id);
        if (node) return node;
        node = {
            key,
            entry: { ...entry, tileKey: key },
            children: [],
            state: state(key, 0),
            area: 0
        };
        nodes.set(id, node);
        if (key.level > 0) insert(key.parent(), entry).children.push(node);
        return node;
    }
    for (const entry of desired) {
        const key = entry.tileKey;
        const level = Math.max(0, 3 * Math.floor((key.level - 2) / 3));
        bootstrap.add(key.changedLevelBy(level - key.level).mortonCode());
        insert(key, entry);
    }
    // Only visible descendants participate in this sparse tree.
    function classify(node) {
        for (const child of node.children) classify(child);
        node.hasReadyChild = node.children.some(
            child => child.hasReadyChild || child.state === "ready"
        );
        node.area = node.children.length
            ? node.children.reduce((a, c) => a + c.area, 0)
            : Math.min(1, Math.max(0.001, node.entry.area || 0));
    }
    const root = nodes.get(1);
    classify(root);
    const rendered = [],
        retain = [],
        groups = [],
        uncovered = new Set();
    // Reveal each resident branch immediately. If a sibling is still loading,
    // its footprint can borrow a cropped patch of the nearest resident ancestor.
    // Draw the ancestor whole whenever no descendant improves the visible surface.
    function reveal(node, ancestor) {
        if (node.state === "ready") ancestor = node;
        if (node.hasReadyChild) {
            for (const child of node.children) reveal(child, ancestor);
        } else if (ancestor === node) {
            rendered.push(node.entry);
        } else if (ancestor) {
            rendered.push({ ...node.entry, cropFrom: ancestor.key });
        } else if (node.children.length) {
            for (const child of node.children) reveal(child);
        } else {
            uncovered.add(node.key.mortonCode());
        }
    }
    const candidates = new Map(),
        retained = new Set();
    function request(node, score, missing) {
        const code = node.key.mortonCode();
        let group = candidates.get(code);
        if (!group) {
            group = { requests: [node], area: 0, missing };
            candidates.set(code, group);
            groups.push(group);
        }
        group.area += score;
    }
    const focusX = focus ? (focus.longitude + 180) / 360 : -1;
    const focusY = focus
        ? (1 - Math.asinh(Math.tan((focus.latitude * Math.PI) / 180)) / Math.PI) / 2
        : -1;
    // Find the best representative for each leaf independent of its siblings.
    // An already loading ancestor continues as long as its region is in view.
    function visit(node, covering, boot, pending) {
        if (node.state === "ready") {
            covering = node;
            pending = undefined;
        } else if (node.state === "pending" && !pending) pending = node;
        if (bootstrap.has(node.key.mortonCode())) boot = node;
        if (node.children.length) {
            for (const child of node.children) visit(child, covering, boot, pending);
        } else if (node !== covering) {
            const key = node.key,
                n = 2 ** key.level;
            const x = Math.abs(focusX * n - key.column - 0.5);
            const focusDistance = focus
                ? Math.max(0, Math.hypot(Math.min(x, n - x), focusY * n - key.row - 0.5) - 0.7)
                : 100;
            const attention = 1 + 8 / (1 + focusDistance * focusDistance);
            let candidate = pending;
            if (!candidate) {
                // Three zoom levels deliver an eightfold resolution gain while
                // each intermediate can still cover a cluster of nearby leaves.
                const z = covering
                    ? Math.min(key.level, covering.key.level + 3)
                    : (boot ?? node).key.level;
                candidate = nodes.get(key.changedLevelBy(z - key.level).mortonCode());
            }
            if (candidate.key.level > detailBase) {
                const base = nodes.get(key.changedLevelBy(detailBase - key.level).mortonCode());
                if (base.state !== "ready") candidate = base;
                else if (!retained.has(base)) {
                    retain.push(base.entry);
                    retained.add(base);
                }
            }
            request(
                candidate,
                attention *
                    (screenArea ? screenArea(key, node.area) : node.area) *
                    (covering ? Math.min(8, key.level - covering.key.level) : 3),
                !covering
            );
        }
    }
    visit(root);
    reveal(root);
    if (uncovered.size)
        for (const tile of previous) {
            if (!tile.hasGeometry || tile.delayRendering) continue;
            let key = tile.tileKey;
            while (key.level > 0 && !uncovered.has(key.mortonCode())) key = key.parent();
            if (uncovered.has(key.mortonCode())) rendered.push(tile);
        }
    // One request may improve several high-area leaves. Spend limited network
    // slots on the largest projected benefit, accounting for the focus point.
    // Seed the close shared view in parallel with the broad cover. An
    // in-flight continental ancestor should not serialize the first local DEM.
    for (const key of openingTiles ?? []) {
        const node = nodes.get(key.mortonCode());
        if (node && node.state !== "ready") request(node, 1e6, true);
    }
    groups.sort((a, b) => b.area - a.area);
    if (selectRequests)
        return { requests: selectRequests(groups, limit), rendered, retain, complete: false };
    const requests = [];
    for (const group of groups) {
        for (const target of group.requests)
            if (requests.length < limit) requests.push(target.entry);
        if (requests.length >= limit) break;
    }
    return { requests, rendered, retain, complete: false };
}
module.exports.planTerrainTiles = planTerrainTiles;

// During an endpoint-wide outage, previously fetched foreground geometry remains
// useful. Regional patches elsewhere carry high-resolution satellite imagery.
function regionalFallbackCut(desired, state, level) {
    const warm = new Set();
    for (const entry of desired) {
        const key = entry.tileKey;
        if (key.level > level && state(key, entry.offset) === "ready")
            warm.add(key.changedLevelBy(level - key.level).mortonCode());
    }
    const cut = new Map();
    for (const entry of desired) {
        const key = entry.tileKey;
        const parent = key.level > level ? key.changedLevelBy(level - key.level) : key;
        const keep = key === parent || warm.has(parent.mortonCode());
        const id = (keep ? key : parent).mortonCode();
        if (!cut.has(id)) cut.set(id, keep ? entry : { ...entry, tileKey: parent });
    }
    return Array.from(cut.values());
}
module.exports.regionalFallbackCut = regionalFallbackCut;
