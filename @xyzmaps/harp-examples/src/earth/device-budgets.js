// Browser-reported memory is coarse (GiB) and optional. The values below bound
// evictable caches. Visible terrain, render targets and driver allocations are
// accounted separately and can temporarily exceed these budgets.
function deviceBudgets(device) {
    const memory = device?.deviceMemory;
    if (memory > 0 && memory <= 2) {
        return { terrainMiB: 80, visibleTiles: 65, rasterMiB: 32 };
    }
    if (memory > 0 && memory <= 4) {
        return { terrainMiB: 120, visibleTiles: 85, rasterMiB: 48 };
    }
    return { terrainMiB: 200, visibleTiles: 100, rasterMiB: 96 };
}
function softwareRasterizer(gl) {
    if (gl.isContextLost()) return false;
    const surface = /swiftshader|llvmpipe|softpipe|lavapipe|software rasterizer|microsoft basic render driver/i;
    if (surface.test(gl.getParameter(gl.RENDERER))) return true;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return !!debug && surface.test(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
}
function softwarePixelRatio(width, height, nativeRatio) {
    return Math.min(nativeRatio, Math.sqrt(150000 / Math.max(1, width * height)));
}
module.exports = { deviceBudgets, softwareRasterizer, softwarePixelRatio };
