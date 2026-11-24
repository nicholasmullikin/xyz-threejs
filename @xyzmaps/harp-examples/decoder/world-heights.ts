import { rasterError } from "../src/earth/terrain-raster-error";

export interface WorldHeightPage {
    kind: "terrarium-webp";
    raster: Blob | ArrayBuffer;
    page?: number;
    x: number;
    y: number;
    size: number;
}

// A Mapterhorn source image covers four ordinary terrain tiles. Keep up to two
// decoded pages per worker during a burst of sibling requests.
export class WorldHeights {
    private readonly pages = new Map<number, Promise<ImageData>>();
    private context?: OffscreenCanvasRenderingContext2D;
    private idleTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;

    private clear() {
        this.pages.clear();
        if (this.context) this.context.canvas.width = this.context.canvas.height = 1;
        this.context = undefined;
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.idleTimer);
        this.clear();
    }

    private async unpack(raster: Blob | ArrayBuffer) {
        const blob = raster instanceof Blob ? raster : new Blob([raster], { type: "image/webp" });
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" })
            .catch(error => { throw rasterError(error); });
        try {
            if (this.disposed) throw new DOMException("Terrain decoder disposed", "AbortError");
            if (bitmap.width !== 512 || bitmap.height !== 512) throw rasterError("Invalid world elevation dimensions");
            if (!this.context) {
                const canvas = new OffscreenCanvas(512, 512);
                this.context = canvas.getContext("2d", { willReadFrequently: true }) ?? undefined;
                if (!this.context) throw Error("Terrain raster decoder unavailable");
            }
            this.context.drawImage(bitmap, 0, 0);
            return this.context.getImageData(0, 0, 512, 512);
        } finally {
            bitmap.close();
        }
    }

    async read({ raster, page, x, y, size }: WorldHeightPage) {
        let loading = page === undefined ? undefined : this.pages.get(page);
        if (!loading) {
            loading = this.unpack(raster);
            if (page !== undefined) loading.catch(() => {
                if (this.pages.get(page) === loading) this.pages.delete(page);
            });
        }
        if (page !== undefined) {
            this.pages.delete(page);
            this.pages.set(page, loading);
            if (this.pages.size > 2) this.pages.delete(this.pages.keys().next().value!);
        }
        try {
            const image = await loading;
            const bytes = image.data, heights = new Float32Array(size * size);
            let i = 0, minHeight = Infinity, maxHeight = -Infinity;
            for (let row = y; row < y + size; row++) {
                let p = 4 * (row * image.width + x);
                for (let col = 0; col < size; col++, p += 4) {
                    const h = bytes[p] * 256 + bytes[p + 1] + bytes[p + 2] / 256 - 32768;
                    heights[i++] = h;
                    minHeight = Math.min(minHeight, h);
                    maxHeight = Math.max(maxHeight, h);
                }
            }
            return { width: size, heights, minHeight, maxHeight };
        } finally {
            if (!this.disposed) {
                clearTimeout(this.idleTimer);
                this.idleTimer = setTimeout(() => this.clear(), 3500);
            }
        }
    }
}
