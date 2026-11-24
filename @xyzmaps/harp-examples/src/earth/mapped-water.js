const { SIDE } = require("./water-mask");
const GRID = 4,
    N = 2 ** 14,
    WIDTH = GRID * SIDE;
const { SIZE, makeSlopes } = require("./ocean-spectrum");
const HEIGHT = WIDTH + SIZE + 2;
function expand(bits, data, x, y, stride = WIDTH) {
    for (let row = 0; row < SIDE; row++)
        for (let byte = 0; byte < SIDE / 8; byte++) {
            const v = bits[(row * SIDE) / 8 + byte],
                i = (y + row) * stride + x + byte * 8;
            if (v === 0) continue;
            if (v === 255) data.fill(255, i, i + 8);
            else for (let j = 0; j < 8; j++) data[i + j] = v & (1 << j) ? 255 : 0;
        }
}
function mappedWater(THREE, map, fetchEnabled=false) {
    const supported = map.renderer.capabilities.maxTextures >= 16;
    const stats = {
        supported,
        enabled: supported,
        active: false,
        shore: false,
        tiles: 0,
        uploads: 0,
        uploadBytes: 0
    };
    let data,
        workTimer,
        disposed = false,
        slopes;
    let tilePatch, slopePatch, fetchPatch;
    const fetchWidth=require("./water-fetch").SIDE;
    const fetchX=4*(SIZE+2);
    const offset = new THREE.Vector2();
    const format = map.renderer.capabilities.isWebGL2 ? THREE.RedFormat : THREE.LuminanceFormat;
    const fades = new Float32Array(16),
        births = new Map();
    function fillSlopes() {
        const job = makeSlopes();
        function advance() {
            if (disposed) return;
            const start = performance.now();
            do {
                const step = job.next();
                if (!step.done) continue;
                // Four padded scalar planes share the bottom of the mask
                // texture. Explicit periodic borders keep linear filtering
                // continuous without an additional terrain sampler.
                slopes = new Uint8Array(WIDTH * (SIZE + 2));
                for (let plane = 0; plane < 4; plane++)
                    for (let y = -1; y <= SIZE; y++)
                        for (let x = -1; x <= SIZE; x++) {
                            const src =
                                (((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)) * 4 + plane;
                            slopes[(y + 1) * WIDTH + plane * (SIZE + 2) + x + 1] = step.value[src];
                        }
                workTimer = undefined;
                if (texture) {
                    const bottom=data.subarray(WIDTH*WIDTH);
                    for(let row=0;row<SIZE+2;row++)
                        bottom.set(slopes.subarray(row*WIDTH,row*WIDTH+fetchX),row*WIDTH);
                    slopePatch = new THREE.DataTexture(bottom, WIDTH, SIZE + 2, format);
                    map.renderer.copyTextureToTexture(offset.set(0, WIDTH), slopePatch, texture);
                    stats.uploadBytes += slopes.length;
                }
                serial++;
                map.update();
                return;
            } while (performance.now() - start < 1.5);
            workTimer = setTimeout(advance, 0);
        }
        workTimer = setTimeout(advance, 0);
    }
    let texture,
        previous = [],
        x0,
        y0,
        serial = 0,
        hasFades = false;
    const mod = x => ((x % N) + N) % N;
    function release() {
        texture?.dispose();
        texture = undefined;
        data = undefined;
        tilePatch?.dispose();
        tilePatch = undefined;
        fetchPatch?.dispose();
        fetchPatch=undefined;
        slopePatch?.dispose();
        slopePatch = undefined;
        if (stats.active) serial++;
        stats.active = false;
        stats.shore = false;
        stats.tiles = 0;
        previous = [];
        births.clear();
        x0 = y0 = undefined;
    }
    function update(entries, mode) {
        const entry = entries.find(e => e.dataSource.name === "buildings");
        if (!stats.enabled || !entry || mode !== "a" || map.zoomLevel < 13.1) {
            if (texture) release();
            return;
        }
        const lat = (map.target.latitude * Math.PI) / 180;
        const left = Math.round(((map.target.longitude + 180) / 360) * N) - 2,
            top = Math.round((1 - Math.asinh(Math.tan(lat)) / Math.PI) * 0.5 * N) - 2;
        const masks = Array(16),
            sameOrigin = x0 === left && y0 === top;
        let count = 0;
        for (const tile of entry.renderedTiles.values()) {
            const bits = tile.waterMask;
            if (!bits) continue;
            const x = mod(tile.tileKey.column - left),
                y = tile.tileKey.row - top;
            if (x < GRID && y >= 0 && y < GRID) {
                masks[y * GRID + x] = bits;
                count++;
            }
        }
        if (!count) {
            if (texture) release();
            return;
        }
        const now = performance.now();
        const same =
            sameOrigin && count === stats.tiles && masks.every((m, i) => previous[i] === m);
        if (same && !hasFades) return;
        if (!same) {
            const ids = new Set();
            masks.forEach((_, i) => {
                const id = mod(left + (i % 4)) + N * (top + Math.floor(i / 4));
                ids.add(id);
                if (!births.has(id)) {
                    births.set(id, now);
                    hasFades = true;
                }
            });
            for (const id of births.keys()) if (!ids.has(id)) births.delete(id);
        }
        // Always record the final 1.0 before parking the frame loop.
        let fading = false;
        masks.forEach((_, i) => {
            const id = mod(left + (i % 4)) + N * (top + Math.floor(i / 4));
            const t = Math.min(1, (now - births.get(id)) / 460);
            fades[i] = t * t * (3 - 2 * t);
            fading ||= t < 1;
        });
        hasFades = fading;
        if (fading) map.update();
        if (same) return;
        if (!data) {
            data = new Uint8Array(WIDTH * HEIGHT);
            if (slopes) data.set(slopes, WIDTH * WIDTH);
            else if (workTimer === undefined) fillSlopes();
            tilePatch = new THREE.DataTexture(new Uint8Array(SIDE * SIDE), SIDE, SIDE, format);
        }
        const changed = [];
        for (let i = 0; i < 16; i++) if (masks[i] !== previous[i]) changed.push(i);
        // Full uploads are cheaper when an entire atlas moves. During
        // streaming only the arriving or departing tile normally changes.
        const partial = texture && changed.length <= 5;
        for (const i of changed) {
            const x = (i % GRID) * SIDE,
                y = Math.floor(i / GRID) * SIDE,
                bytes = tilePatch.image.data;
            bytes.fill(0);
            if (masks[i]) expand(masks[i], bytes, 0, 0, SIDE);
            for (let row = 0; row < SIDE; row++)
                data.set(bytes.subarray(row * SIDE, (row + 1) * SIDE), (y + row) * WIDTH + x);
            if (partial) {
                map.renderer.copyTextureToTexture(offset.set(x, y), tilePatch, texture);
                stats.uploadBytes += bytes.length;
            }
        }
        if(fetchEnabled){
            fetchPatch??=new THREE.DataTexture(new Uint8Array(fetchWidth*fetchWidth),fetchWidth,fetchWidth,format);
            const patch=fetchPatch.image.data;
            const metres=Math.cos(lat)*40075016.7/N*GRID/fetchWidth;
            require("./water-fetch").fillFetch(data,WIDTH,masks,metres,patch);
            for(let row=0;row<fetchWidth;row++)
                data.set(patch.subarray(row*fetchWidth,(row+1)*fetchWidth),(WIDTH+row+1)*WIDTH+fetchX);
            if(partial){
                map.renderer.copyTextureToTexture(offset.set(fetchX,WIDTH+1),fetchPatch,texture);
                stats.uploadBytes+=patch.length;
            }
        }
        if (!texture) {
            texture = new THREE.DataTexture(data, WIDTH, HEIGHT, format);
            texture.minFilter = texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = false;
            texture.unpackAlignment = 1;
        }
        if (!partial) {
            texture.needsUpdate = true;
            stats.uploadBytes += data.length;
        }
        previous = masks;
        x0 = left;
        y0 = top;
        stats.tiles = count;
        stats.shore = masks.some(bits=>bits.some(byte=>byte!==255));
        stats.uploads++;
        stats.active = true;
        serial++;
    }
    function bind(mat, key) {
        const d = mat.defines;
        if (!stats.active) {
            if (d.EARTH_MAPPED_WATER) {
                delete d.EARTH_MAPPED_WATER;
                mat.uniforms.mappedWater.value = null;
                mat.needsUpdate = true;
            }
            return;
        }
        if (!d.EARTH_MAPPED_WATER) {
            d.EARTH_MAPPED_WATER = 1;
            mat.needsUpdate = true;
        }
        mat.uniforms.mappedWater.value = texture;
        mat.uniforms.waterFades.value = fades;
        mat.uniforms.waveDetail.value = slopes ? 1 : 0;
        mat.uniforms.waterPhase.value.set((x0 % 32) / GRID, (y0 % 32) / GRID);
        const scale = 2 ** (14 - key.level),
            dx = mod(key.column * scale - x0 + N / 2) - N / 2;
        mat.uniforms.waterUv.value.set(
            scale / GRID,
            -scale / GRID,
            dx / GRID,
            ((key.row + 1) * scale - y0) / GRID
        );
    }
    return {
        stats,
        update,
        bind,
        nearbyLevel(target,elevation,sample) {
            if(!stats.active)return;
            const x=(target.longitude+180)/360*N, y=(1-Math.asinh(Math.tan(target.latitude*Math.PI/180))/Math.PI)*.5*N;
            let best=Infinity, level;
            // Sample interiors of classified water polygons. A camera focused
            // on a hillside can still see a lake hundreds of metres below it.
            previous.forEach((bits,i)=>{
                const left=x0+i%4, top=y0+Math.floor(i/4);
                for(let v=8;v<SIDE;v+=16)for(let u=8;u<SIDE;u+=16){
                    if(!(bits[(v*SIDE+u)>>3]&(1<<(u&7))))continue;
                    const mx=left+(u+.5)/SIDE,my=top+(v+.5)/SIDE;
                    const dx=mod(mx-x+N/2)-N/2,d=(my-y)**2+dx*dx;
                    if(d<best){best=d;level=[mod(mx)/N,my/N];}
                }
            });
            if (!level) return;
            sample.set(...level);
            return elevation.atMercator(...level);
        },
        get revision() {
            return serial;
        },
        setEnabled(on) {
            stats.enabled = !!on && supported;
            map.update();
        },
        dispose() {
            disposed = true;
            clearTimeout(workTimer);
            release();
            slopes = undefined;
        }
    };
}
module.exports = { mappedWater, expand };
