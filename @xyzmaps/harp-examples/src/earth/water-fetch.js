// Estimate upwind open-water distance from the resident shoreline mask. West
// and south neighbours lie upwind of the simulated prevailing wind. Unknown
// cells remain exposed until a survey supplies a shoreline.
const SIDE = 128;
function fillFetch(mask, stride, present, metres, out) {
    const distance = new Float32Array(SIDE);
    distance.fill(1800);
    for (let y = SIDE - 1; y >= 0; y--) {
        let west = 1800;
        for (let x = 0; x < SIDE; x++) {
            const tile = (y >> 5) * 4 + (x >> 5);
            const cell =
                Math.floor(((y + 0.5) * stride) / SIDE) * stride +
                Math.floor(((x + 0.5) * stride) / SIDE);
            const wet = mask[cell] !== 0;
            const sheltered = present[tile] && !wet;
            const fetch = sheltered
                ? 0
                : present[tile]
                  ? Math.min(1800, metres + 0.62 * west + 0.38 * distance[x])
                  : 1800;
            west = distance[x] = fetch;
            // Retain capillary ripples in small, sheltered pools.
            out[y * SIDE + x] = Math.round(255 * Math.min(1, fetch / 1400));
        }
    }
}
module.exports = { SIDE, fillFetch };
