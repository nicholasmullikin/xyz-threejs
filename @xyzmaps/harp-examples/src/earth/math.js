const R = 6378137;
function clipPlanes() {
    return {
        minElevation: -500,
        maxElevation: 9000,
        evaluateClipPlanes(camera) {
            const height = Math.max(0, camera.position.length() - R),
                peak = Math.max(0, this.maxElevation);
            const horizon = Math.sqrt(height * (2 * R + height)) + Math.sqrt(peak * (2 * R + peak));
            const far = Math.max(80000, horizon * 1.12 + 20000);
            const near = Math.max(0.5, Math.min(10000, (height - peak) * 0.08));
            return { near, far, minimum: 0.5, maximum: far };
        }
    };
}
function transform(child, parent) {
    const scale = 2 ** (parent.z - child.z);
    return [scale, scale, child.x * scale - parent.x, 1 - (child.y + 1) * scale + parent.y];
}
let oceanTile;
async function fetchTerrain(tileKey, token, signal) {
    const { level: z, column: x, row: y } = tileKey;
    const response = await fetch(
        `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${token}`,
        { signal }
    );
    if (response.ok) return response.arrayBuffer();
    // The provider returns 404 for all-water tiles. Generate a true zero-height
    // DEM, rather than treating an ocean as a failed terrain refinement.
    if (response.status !== 404) throw new Error(`Terrain request failed: HTTP ${response.status}`);
    if (!oceanTile)
        oceanTile = new Promise(resolve => {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 256;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "rgb(1,134,160)";
            ctx.fillRect(0, 0, 256, 256);
            canvas.toBlob(async blob => resolve(await blob.arrayBuffer()), "image/png");
        });
    return (await oceanTile).slice(0);
}
function triangleHeight(h00, h10, h01, h11, x, y) {
    return x + y <= 1
        ? h00 * (1 - x - y) + h10 * x + h01 * y
        : h11 * (x + y - 1) + h01 * (1 - x) + h10 * (1 - y);
}

module.exports = { R, clipPlanes, transform, fetchTerrain, triangleHeight };
