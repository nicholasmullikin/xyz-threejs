const { samplePosition } = require("./terrain-sample");

// Keep the crossover monotone in surveyed height. A small local vertical
// disagreement settles over tens of meters; a larger one receives a broader
// transition without inventing a vertical wall at the survey boundary.
function surveyWeight(distance, delta, maximum) {
    const width = Math.min(maximum / 1.25, Math.max(32, 4 * Math.abs(delta)));
    const q = distance / width;
    const saturated = q >= 1.25 ? 1 : q <= 0.75 ? q : 1 - (1.25 - q) ** 2;
    const edge = Math.min(1, distance / 12);
    return edge * edge * (3 - 2 * edge) * saturated;
}

// Pack alpha records distance to surveyed coverage. Resolve nodata against the exact same
// worldwide surface across every child, including overlaps between UTM projects.
function blendParentHeights(heights, img, child, parent, radius, edgeDistancePixels = 0) {
    const surface = parent?.kind === "parent-terrain-surface" ? parent : undefined;
    const scale = surface ? 2 ** (child.level - parent.level) : 1;
    const dx = surface ? child.column - parent.column * scale : 0;
    const dy = surface ? child.row - parent.row * scale : 0;
    const mercator = Math.PI * (1 - (2 * (child.row + 0.5)) / 2 ** child.level);
    const maximum =
        (edgeDistancePixels * 2 * Math.PI * radius) / (256 * 2 ** 17 * Math.cosh(mercator));
    const p = {},
        m = surface?.matrix;
    let minHeight = Infinity,
        maxHeight = -Infinity;
    for (let y = 0; y < img.height; y++) {
        const v = (dy + (y + 0.5) / img.height) / scale;
        for (let x = 0; x < img.width; x++) {
            const i = y * img.width + x,
                alpha = img.data[4 * i + 3];
            if (alpha < 255) {
                let base = 0;
                if (surface) {
                    const u = (dx + (x + 0.5) / img.width) / scale;
                    samplePosition(surface, u, v, p);
                    const wx = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
                    const wy = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
                    const wz = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
                    base = Math.sqrt(wx * wx + wy * wy + wz * wz) - radius;
                }
                const delta = heights[i] - base;
                const fraction = alpha / 255;
                heights[i] =
                    base +
                    delta * (maximum ? surveyWeight(fraction * maximum, delta, maximum) : fraction);
            }
            minHeight = Math.min(minHeight, heights[i]);
            maxHeight = Math.max(maxHeight, heights[i]);
        }
    }
    return { minHeight, maxHeight };
}
module.exports = { blendParentHeights, surveyWeight };
