const { planTerrainTiles } = require("./terrain-selection");

// Reuse the imagery pass's low-resolution visibility samples. A projected
// bounding box can cover most of the screen while its terrain is behind a ridge.
// Store coordinates only, so these priorities cannot pin evicted scene tiles.
function createTerrainFeedback() {
    let samples = new Float64Array(0),
        count = 0,
        captured = -Infinity,
        distance;
    let rotation, position;
    const levels = new Map();
    function set(map, hits, now) {
        count = hits?.length ?? 0;
        levels.clear();
        if (count < 8) return;
        if (samples.length < count * 3) samples = new Float64Array(count * 3);
        for (let i = 0; i < count; i++) {
            const { mx, my, ndcX, ndcY } = hits[i];
            samples[3 * i] = mx;
            samples[3 * i + 1] = my;
            samples[3 * i + 2] = 1 / (1 + ndcX * ndcX + ndcY * ndcY);
        }
        captured = now;
        distance = map.targetDistance;
        (rotation ??= map.camera.quaternion.clone()).copy(map.camera.quaternion);
        (position ??= map.camera.position.clone()).copy(map.camera.position);
    }
    function observedShare(key) {
        const n = 2 ** key.level;
        let weights = levels.get(key.level);
        if (!weights) {
            weights = new Map();
            for (let i = 0; i < count; i++) {
                const id = Math.floor(samples[i * 3 + 1] * n) * n + Math.floor(samples[i * 3] * n);
                weights.set(id, (weights.get(id) ?? 0) + samples[i * 3 + 2]);
            }
            levels.set(key.level, weights);
        }
        return (weights.get(key.row * n + key.column) ?? 0) / count;
    }
    function area(key, projected) {
        // Keep a geometric floor for narrow silhouettes that fall between samples.
        return 0.03 * projected + 3 * observedShare(key);
    }
    function current(map, now, shareOnly = false) {
        if (
            count < 8 ||
            now - captured > 600 ||
            rotation.angleTo(map.camera.quaternion) > 0.15 ||
            position.distanceTo(map.camera.position) > 0.25 * Math.max(100, distance)
        )
            return;
        return shareOnly ? observedShare : area;
    }
    return { set, current };
}

// A fast retreat can otherwise replace a resident z15 cliff directly with its
// z12 bootstrap surface while the missing z14 parent starts downloading.
function nextRetreatParent(tiles, desired, pending, state, share, focus) {
    if (!focus) return;
    const mx = (focus.longitude + 180) / 360;
    const my = (1 - Math.asinh(Math.tan((focus.latitude * Math.PI) / 180)) / Math.PI) / 2;
    const requested = new Set(desired.map(entry => entry.tileKey.mortonCode()));
    let priority = 0.2, best;
    for (const tile of tiles) {
        if (!tile.hasGeometry || tile.disposed) continue;
        let key = tile.tileKey;
        for (let gap = 1; gap <= 2 && key.level > 12; gap++) {
            key = key.parent();
            const id = key.mortonCode();
            if (requested.has(id) || pending.has(id) || state(key, 0)) continue;
            const n = 2 ** key.level;
            const longitude = Math.abs(key.column + 0.5 - mx * n);
            const x = Math.min(longitude, n - longitude);
            const y = key.row + 0.5 - my * n;
            const score = (2 * (share?.(key) ?? 0) + 1 / (2 + x * x + y * y)) / (gap * gap);
            if (score > priority) {
                best = key;
                priority = score;
            }
        }
    }
    return best;
}

// Limit new network work when patches are moving quickly across the screen.
// The render cut still considers every resident tile at its ordinary resolution.
function createTerrainStream(isConstrained = () => false, detailBase = Infinity) {
    const feedback = createTerrainFeedback();
    const parents = new Map();
    let previousPosition, previousRotation, previousTime, previousDistance;
    let fastUntil = -Infinity,
        credits = 4,
        seen = new Map(),
        timer;
    let retreatUntil = -Infinity, lastParent = -Infinity;
    function update(map, desired, state, previous, now = performance.now(), allowParents = true, openingTiles) {
        const camera = map.camera;
        if (previousPosition) {
            const dt = Math.max(4, now - previousTime);
            const focal = map.canvas.clientHeight * camera.projectionMatrix.elements[5] * 0.5;
            const angle = previousRotation.angleTo(camera.quaternion);
            const travel =
                previousPosition.distanceTo(camera.position) /
                Math.max(20, Math.min(previousDistance, map.targetDistance));
            const motion = ((angle + travel) * focal * 1000) / dt;
            if (motion > map.canvas.clientHeight * 0.28) fastUntil = now + 180;
            if (
                Math.log(map.targetDistance / previousDistance) > 0.00015 * dt &&
                camera.position.lengthSq() > previousPosition.lengthSq()
            )
                retreatUntil = now + 210;
            credits = Math.min(4, credits + dt * 0.006);
        } else {
            previousPosition = camera.position.clone();
            previousRotation = camera.quaternion.clone();
        }
        previousPosition.copy(camera.position);
        previousRotation.copy(camera.quaternion);
        previousDistance = map.targetDistance;
        previousTime = now;
        const fast = now < fastUntil;
        const constrained = isConstrained();
        const nextSeen = new Map();
        const canStartParent = allowParents && now < retreatUntil &&
            now - lastParent >= 220 && parents.size < (constrained ? 1 : 2);
        const lastCut = canStartParent ? Array.from(previous) : previous;
        const result = planTerrainTiles(
            desired,
            state,
            lastCut,
            constrained ? 4 : 12,
            (groups, limit) => {
                const requested = [];
                // Existing useful downloads survive a movement-state or priority change.
                for (const group of groups)
                    for (const target of group.requests)
                        if (target.state === "pending") requested.push(target.entry);
                for (const group of groups)
                    for (const target of group.requests) {
                        const id = target.key.mortonCode(),
                            first = seen.get(id) ?? now;
                        nextSeen.set(id, first);
                        if (
                            target.state === "pending" ||
                            requested.length >= (fast ? (constrained ? 2 : 5) : limit)
                        )
                            continue;
                        if (fast && (credits < 1 || (!group.missing && now - first < 120)))
                            continue;
                        requested.push(target.entry);
                        if (fast) credits--;
                    }
                return requested;
            },
            map.target,
            feedback.current(map, now),
            detailBase,
            openingTiles
        );
        seen = nextSeen;
        for (const [id, item] of parents) {
            if (!allowParents || state(item.entry.tileKey, 0) === "ready" || now - item.start > 2300)
                parents.delete(id);
        }
        if (canStartParent && (result.complete || result.requests.length < (constrained ? 2 : 5))) {
            const key = nextRetreatParent(lastCut, desired, parents, state, feedback.current(map, now, true), map.target);
            if (key) {
                parents.set(key.mortonCode(), { entry: { tileKey: key, offset: 0, distance: 0, area: 1 }, start: now });
                lastParent = now;
            }
        }
        if (parents.size) {
            // Keep the existing disjoint draw cover. Pending parents occupy loader
            // slots only, even when every requested on-screen leaf is resident.
            result.requests = [
                ...Array.from(parents.values(), item => item.entry),
                ...result.requests.filter(e => !parents.has(e.tileKey.mortonCode()))
            ];
            result.complete = false;
        }
        if (fast && !result.complete && timer === undefined) {
            timer = setTimeout(() => {
                timer = undefined;
                map.update();
            }, 200);
        }
        return result;
    }
    return {
        update,
        setFeedback: feedback.set,
        visibleShare: (map, now) => feedback.current(map, now, true),
        dispose() {
            clearTimeout(timer);
            timer = undefined;
            seen.clear();
            parents.clear();
        }
    };
}
module.exports = { createTerrainStream, createTerrainFeedback };
