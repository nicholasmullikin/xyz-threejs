import { rasterError } from "../src/earth/terrain-raster-error";

// NOAA ETOPO regional pages encode square-root height in gray and water/sign
// in alpha. Decode once per region per worker; adjacent tile requests share it.
interface ReliefPage {
    page: string;
    raster: Blob | ArrayBuffer;
    size: number;
    scale: number;
    x: number;
    y: number;
}

const pages = new Map<string, Promise<Int16Array>>();
const meters = Int16Array.from({ length: 256 }, (_, i) => Math.round(9000 * (i / 255) ** 2));

async function unpack(page: ReliefPage) {
    const blob = page.raster instanceof Blob ? page.raster : new Blob([page.raster], { type: "image/webp" });
    const bitmap = await createImageBitmap(blob, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none"
    }).catch(error => { throw rasterError(error); });
    const width = page.size + 2;
    const canvas = new OffscreenCanvas(width, width);
    try {
        if (bitmap.width !== width || bitmap.height !== width)
            throw rasterError("Invalid bundled elevation dimensions");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw Error("Elevation canvas unavailable");
        context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, width, width).data;
        const heights = new Int16Array(width * width);
        for (let i = 0, j = 0; i < heights.length; i++, j += 4) {
            const a = pixels[j + 3];
            heights[i] = a === 0 ? 0 : a === 255 ? meters[pixels[j]] : -meters[pixels[j]];
        }
        return heights;
    } finally {
        bitmap.close();
        canvas.width = canvas.height = 1;
    }
}

export function baselinePage(page: ReliefPage) {
    let loading = pages.get(page.page);
    if (!loading)
        loading = unpack(page).catch(error => {
            pages.delete(page.page);
            throw error;
        });
    pages.delete(page.page);
    pages.set(page.page, loading);
    if (pages.size > 3) pages.delete(pages.keys().next().value!);
    return loading;
}

export async function baselineHeights(page: ReliefPage) {
    const source = await baselinePage(page);
    const span = page.size / page.scale;
    // Only sample the part covered by this tile. At street altitude that is
    // typically a fraction of one elevation pixel.
    const width = Math.max(8, Math.min(128, Math.ceil(span)));
    const heights = new Float32Array(width ** 2);
    let minHeight = Infinity,
        maxHeight = -Infinity;
    const stride = page.size + 2;
    for (let y = 0; y < width; y++) {
        const sy = 0.5 + (page.y + (y + 0.5) / width) * span;
        const iy = Math.floor(sy),
            fy = sy - iy;
        for (let x = 0; x < width; x++) {
            const sx = 0.5 + (page.x + (x + 0.5) / width) * span;
            const ix = Math.floor(sx),
                fx = sx - ix;
            const i = iy * stride + ix;
            const h =
                (source[i] * (1 - fx) + source[i + 1] * fx) * (1 - fy) +
                (source[i + stride] * (1 - fx) + source[i + stride + 1] * fx) * fy;
            heights[y * width + x] = h;
            minHeight = Math.min(minHeight, h);
            maxHeight = Math.max(maxHeight, h);
        }
    }
    return { width, heights, minHeight, maxHeight };
}
