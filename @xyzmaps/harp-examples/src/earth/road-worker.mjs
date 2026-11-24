import { rasterRoads } from "./road-raster.mjs";
self.onmessage = event => {
    const { id, buffer } = event.data;
    try {
        const result = rasterRoads(buffer);
        self.postMessage({ id, mask: result.mask, features: result.features }, [result.mask.buffer]);
    } catch (error) {
        self.postMessage({ id, error: String(error?.message || error) });
    }
};
