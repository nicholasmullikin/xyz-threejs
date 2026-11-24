// WorkerService serializes errors with Error.toString() across the worker boundary.
const name = "TerrainRasterError";
export function rasterError(reason: unknown) {
    return Object.assign(new Error(reason instanceof Error ? reason.message : String(reason)), { name });
}
export function isRasterError(error: unknown) {
    return error instanceof Error && (error.name === name || error.message.startsWith(name + ":"));
}
