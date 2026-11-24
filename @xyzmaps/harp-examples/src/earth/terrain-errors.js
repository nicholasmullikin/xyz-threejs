// Each dyadic edge has one midpoint shared by up to two right triangles.
// Visit those midpoints once from the finest spacing up. Edge splits depend
// on the four adjacent finer diagonal splits; cell diagonals then inherit
// the errors of their four enclosing edges.
function updateTerrainErrors(heights, errors, width) {
    const n = width - 1;
    // The corners survive every cut and are never midpoints.
    errors[0] = errors[n] = errors[n * width] = errors[n * width + n] = 0;
    for (let step = 1; step < n; step *= 2) {
        const stride = step * width,
            pitch = 2 * step,
            half = step >> 1,
            halfRow = half * width;
        // Horizontal edges.
        for (let y = 0; y <= n; y += pitch) {
            for (let x = step, i = y * width + x; x < n; x += pitch, i += pitch) {
                let error = Math.abs((heights[i - step] + heights[i + step]) / 2 - heights[i]);
                if (half) {
                    if (y > 0) error = Math.max(error, errors[i - halfRow - half], errors[i - halfRow + half]);
                    if (y < n) error = Math.max(error, errors[i + halfRow - half], errors[i + halfRow + half]);
                }
                errors[i] = error;
            }
        }
        // Vertical edges.
        for (let y = step; y < n; y += pitch) {
            for (let x = 0, i = y * width; x <= n; x += pitch, i += pitch) {
                let error = Math.abs((heights[i - stride] + heights[i + stride]) / 2 - heights[i]);
                if (half) {
                    if (x > 0) error = Math.max(error, errors[i - half - halfRow], errors[i - half + halfRow]);
                    if (x < n) error = Math.max(error, errors[i + half - halfRow], errors[i + half + halfRow]);
                }
                errors[i] = error;
            }
        }
        // Adjacent cells alternate diagonal direction at this spacing.
        for (let y = step; y < n; y += pitch) {
            for (let x = step, i = y * width + x; x < n; x += pitch, i += pitch) {
                const diagonal = ((x ^ y) & pitch) === 0 ? stride + step : stride - step;
                const error = Math.abs((heights[i - diagonal] + heights[i + diagonal]) / 2 - heights[i]);
                errors[i] = Math.max(error, errors[i - step], errors[i + step], errors[i - stride], errors[i + stride]);
            }
        }
    }
}
module.exports = { updateTerrainErrors };
