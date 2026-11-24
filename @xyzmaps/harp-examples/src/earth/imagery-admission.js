// A page can finish while outgoing imagery still occupies every drawable slot.
// Defer decoding that same page again until the fade or its working set changes.
function createReadmission(byteLimit, countLimit, fadeDuration) {
    const declined = new Map();
    let freeBytes = byteLimit;
    let freeSlots = countLimit;
    let waitingForSpace = false;
    return {
        evicted(page, now, epoch) {
            if (page.drawn || now - page.readyAt >= fadeDuration) return;
            if (!declined.has(page.key) && declined.size >= 256) {
                declined.delete(declined.keys().next().value);
            }
            declined.set(page.key, {
                epoch,
                bytes: page.bytes,
                until: now + fadeDuration
            });
        },
        blockedUntil(key, now, epoch) {
            const page = declined.get(key);
            if (!page) return 0;
            if (now < page.until) return page.until;
            if (page.epoch === epoch && (page.bytes > freeBytes || freeSlots < 1)) {
                waitingForSpace = true;
                return Infinity;
            }
            declined.delete(key);
            return 0;
        },
        updatePinned(cache, pinned) {
            if (!declined.size) return false;
            let bytes = byteLimit;
            let slots = countLimit;
            for (const key of pinned) {
                const page = cache.get(key);
                if (page) {
                    bytes -= page.bytes;
                    slots--;
                }
            }
            const wake = waitingForSpace && (bytes > freeBytes || slots > freeSlots);
            waitingForSpace = false;
            freeBytes = bytes;
            freeSlots = slots;
            return wake;
        },
        clear() {
            declined.clear();
        }
    };
}

// New terrain can arrive between visibility plans. Reuse previous geographic
// samples to distinguish a likely visible child from a speculative fringe tile.
function coversPreviousSample(tile, samples) {
    if (!samples?.length) return true;
    const width = 2 ** tile.z;
    return samples.some(s => Math.floor(s.mx * width) === tile.x && Math.floor(s.my * width) === tile.y);
}
module.exports = { createReadmission, coversPreviousSample };
