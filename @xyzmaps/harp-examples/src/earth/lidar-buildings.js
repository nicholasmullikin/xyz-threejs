const { unpack } = require("./building-coordinates");
// Query the interiors of the actual triangulated footprint, including its
// courtyards. Count each airborne grid cell once even on very narrow triangles.
function observedRoof(geometry, start, end, sample, ground, previous = 0) {
    const roof = geometry.attributes.uv,
        xy = geometry.attributes.tileUv,
        index = geometry.index?.array;
    if (!index || roof.getY(start) !== -0.5) return;
    let last = start;
    while (last < end && roof.getY(last) === -0.5) last++;
    if (last - start < 3 || last === end) return;
    if (last + 2 >= end) return;
    const nominal = Math.round(roof.getY(last + 2) - previous);
    if (nominal !== 5 && nominal !== 6) return;
    let left = 0,
        right = index.length / 3;
    while (left < right) {
        const middle = (left + right) >> 1;
        if (index[middle * 3] < start) left = middle + 1;
        else right = middle;
    }
    const cells = new Map();
    let tested = 0,
        covered = 0;
    for (let i = 3 * left; i < index.length && index[i] < last && tested < 120; i += 3) {
        const a = index[i],
            b = index[i + 1],
            c = index[i + 2];
        if (a < start || b < start || c < start || b >= last || c >= last) continue;
        for (const [u, v] of [
            [1 / 3, 1 / 3],
            [0.2, 0.2],
            [0.2, 0.6],
            [0.6, 0.2]
        ]) {
            tested++;
            const w = 1 - u - v;
            const obs = sample(
                unpack(u * xy.getX(a) + v * xy.getX(b) + w * xy.getX(c)),
                unpack(u * xy.getY(a) + v * xy.getY(b) + w * xy.getY(c))
            );
            if (obs) {
                cells.set(obs.id, obs.value);
                covered++;
            }
        }
    }
    if (cells.size < 5 || covered < tested * 0.72) return;
    const values = [...cells.values()].sort((a, b) => a - b),
        median = values[values.length >> 1],
        height = median - ground;
    if (height < 2.5 || height > 65 || Math.abs(height - nominal) < 1.6) return;
    const tolerance = Math.max(1.25, height * 0.05);
    if (values.filter(z => Math.abs(z - median) <= tolerance).length < values.length * 0.8) return;
    return height - nominal;
}
module.exports = { observedRoof };
