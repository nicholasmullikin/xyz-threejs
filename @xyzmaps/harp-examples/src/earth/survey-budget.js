// Reserve by recent response size, settle against actual payload bytes. Credit
// persists when the camera crosses between sources or the layer is toggled.
function surveyBudget(small, clock = () => performance.now(), available = Infinity) {
    const mib = 1024 * 1024,
        capacity = (small ? 12 : 28) * mib,
        perMs = ((small ? 0.2 : 0.48) * mib) / 1000;
    let credit = Math.min(capacity, available),
        held = 0,
        last = clock();
    function refill() {
        const now = clock();
        credit = Math.min(capacity, credit + Math.max(0, now - last) * perMs);
        last = now;
    }
    return {
        available() {
            refill();
            return credit - held;
        },
        reserve(size) {
            refill();
            if (credit - held < size) return false;
            held += size;
            return true;
        },
        release(size) {
            held = Math.max(0, held - size);
        },
        pay(size) {
            refill();
            credit -= size;
        },
        delay(size) {
            refill();
            return Math.max(50, Math.ceil((size + held - credit) / perMs));
        }
    };
}
module.exports = { surveyBudget, lidarEnterDistance: 1100, lidarExitDistance: 1350 };
