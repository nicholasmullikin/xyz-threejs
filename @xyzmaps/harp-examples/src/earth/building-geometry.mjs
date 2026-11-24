import water from "./water-mask.js";
// OpenMapTiles building footprints -> batched globe geometry, off the render thread.
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
import earcut from "earcut";
import { Color } from "three";
import math from "./math.js";
import tileCoordinates from "./building-coordinates.js";
import roofShapes from "./roof-shapes.js";
const R = math.R,
    TAU = Math.PI * 2;
export function signedArea(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        sum += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    return sum / 2;
}
export function polygons(rings) {
    const result = [];
    let current, sign;
    for (let ring of rings) {
        if (ring.length > 1 && ring[0].x === ring.at(-1).x && ring[0].y === ring.at(-1).y)
            ring = ring.slice(0, -1);
        const area = signedArea(ring);
        if (ring.length < 3 || !area) continue;
        if (sign === undefined) sign = Math.sign(area);
        if (Math.sign(area) === sign) {
            current = [ring];
            result.push(current);
        } else if (current) current.push(ring);
    }
    return result;
}
function world(x, y, z, tileX, tileY, extent, height = 0) {
    const lon = ((tileX + x / extent) / 2 ** z - 0.5) * TAU;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + y / extent)) / 2 ** z)));
    const radius = R + height;
    return [
        radius * Math.cos(lat) * Math.cos(lon),
        radius * Math.cos(lat) * Math.sin(lon),
        radius * Math.sin(lat)
    ];
}
export function parseBuildingColor(value) {
    if (typeof value !== "string") return undefined;
    const color = value.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(color);
    if (hex) {
        const digits = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join("") : hex[1];
        return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16));
    }
    if (!Object.prototype.hasOwnProperty.call(Color.NAMES, color)) return undefined;
    const packed = Color.NAMES[color];
    const rgb = [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
    // Unqualified names express a material family rather than calibrated sRGB.
    const gray = (rgb[0] + rgb[1] + rgb[2]) / 3;
    return rgb.map(channel => Math.round(gray + (channel - gray) * 0.4));
}
export function buildTile(buffer, z, x, y, roofTags, includeWater=false) {
    const layers = new VectorTile(new Pbf(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))).layers;
    const layer=layers.building;
    const extent = layer?.extent || 4096,
        origin = world(extent / 2, extent / 2, z, x, y, extent);
    // Uint16 indices work on WebGL 1 even without OES_element_index_uint.
    const chunks = [];
    let pos = [],
        normals = [],
        uv = [],
        base = [],
        colors = [],
        seeds = [],
        tileUv = [],
        index = [];
    const flush = () => {
        if (!index.length) return;
        chunks.push({
            position: new Float32Array(pos),
            normal: new Int16Array(normals),
            uv: new Float32Array(uv),
            baseUv: tileCoordinates.pack(base),
            color: new Uint8Array(colors),
            seed: new Uint16Array(seeds),
            tileUv: tileCoordinates.pack(tileUv),
            index: new Uint16Array(index)
        });
        pos = [];
        normals = [];
        uv = [];
        base = [];
        colors = [];
        seeds = [];
        tileUv = [];
        index = [];
    };
    const reserve = count => {
        if (pos.length / 3 + count > 65535) flush();
    };
    let count = 0, shapedRoofs = 0;
    const vertex = (p, normal, wallUv, center, color, seed, xy) => {
        pos.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
        normals.push(...normal);
        uv.push(...wallUv);
        base.push(...center);
        colors.push(...color);
        seeds.push(seed);
        tileUv.push(xy.x / extent, xy.y / extent);
    };
    const quad = (points, tex, center, color, seed, xy, desired) => {
        const a = points[1].map((v, i) => v - points[0][i]);
        const b = points[2].map((v, i) => v - points[0][i]);
        let n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const length = Math.hypot(...n);
        if (length < 1e-8) return;
        n = n.map(v => v / length);
        const reverse = n.reduce((sum, v, i) => sum + v * desired[i], 0) < 0;
        if (reverse) n = n.map(v => -v);
        n = n.map(v => Math.round(Math.max(-1, Math.min(1, v)) * 32767));
        reserve(4);
        const first = pos.length / 3;
        for (let i = 0; i < 4; i++) vertex(points[i], n, tex[i], center, color, seed, xy[i]);
        if (reverse) index.push(first, first + 2, first + 1, first, first + 3, first + 2);
        else index.push(first, first + 1, first + 2, first, first + 2, first + 3);
    };
    // Keep dense batches local so the GPU can skip city blocks outside the
    // camera frustum. Preserve the source feature index for deterministic colors.
    const divisions = layer?.length >= 700 ? 4 : layer?.length >= 120 ? 2 : 1;
    const cells = Array.from({ length: divisions * divisions }, () => []);
    for (let i = 0; i < (layer?.length || 0); i++) {
        const feature = layer.feature(i),
            props = feature.properties;
        if (feature.type !== 3 || props.hide_3d === true || props.hide_3d === "true") continue;
        const rings = feature.loadGeometry(),
            anchor = rings[0]?.[0];
        if (!anchor) continue;
        const column = Math.max(
            0,
            Math.min(divisions - 1, Math.floor((anchor.x / extent) * divisions))
        );
        const row = Math.max(
            0,
            Math.min(divisions - 1, Math.floor((anchor.y / extent) * divisions))
        );
        cells[row * divisions + column].push({ feature, i, rings });
    }
    for (const cell of cells) {
        for (const { feature, i, rings: geometry } of cell) {
            const props = feature.properties;
            const height = Math.max(2, Math.min(1000, Number(props.render_height) || 6));
            const bottom = Math.max(0, Number(props.render_min_height) || 0);
            if (bottom >= height && !roofTags) continue;
            const seedValue = ((feature.id || i + 1) % 65521) / 65521;
            // Two material-family bits ride in the existing normalized seed.
            // Color tags take precedence when distinguishing glazed towers.
            const taggedColor = parseBuildingColor(props.colour);
            const coolColor = taggedColor && taggedColor[2] > taggedColor[0] + 12;
            const family = height < 14 ? 0 : height > 32 && (coolColor || seedValue > 0.78) ? 2 : 1;
            const seed = Math.round(seedValue * 16383) * 4 + family;
            const color = taggedColor || [0.48 + seedValue * 0.1, 0.47 + seedValue * 0.1, 0.44 + seedValue * 0.12]
                .map(v => Math.round(v * 255));
            for (const rings of polygons(geometry)) {
                const outer = rings[0],
                    center = [
                        outer.reduce((s, p) => s + p.x, 0) / outer.length / extent,
                        outer.reduce((s, p) => s + p.y, 0) / outer.length / extent
                    ];
                if (center[0] < -0.1 || center[0] > 1.1 || center[1] < -0.1 || center[1] > 1.1)
                    continue;
                const flat = [],
                    holes = [],
                    points = [];
                let offset = 0;
                for (let r = 0; r < rings.length; r++) {
                    if (r) holes.push(offset);
                    for (const p of rings[r]) {
                        flat.push(p.x, p.y);
                        points.push(p);
                        offset++;
                    }
                }
                // Width in 512-pixel native z14 imagery at the building's footprint.
                // A roof narrower than a texel should keep its material color.
                let minX = Infinity,
                    maxX = -Infinity,
                    minY = Infinity,
                    maxY = -Infinity;
                for (const point of outer) {
                    minX = Math.min(minX, point.x);
                    maxX = Math.max(maxX, point.x);
                    minY = Math.min(minY, point.y);
                    maxY = Math.max(maxY, point.y);
                }
                const roofUv = [(512 * Math.min(maxX - minX, maxY - minY)) / extent, -1];

                const indices = earcut(flat, holes, 2);
                const tag = roofTags?.match(feature.id,x,y,extent,minX,minY,maxX,maxY);
                // Some elevated parts have a tagged base and a floor-count estimate
                // for their own storeys. Interpret that estimate above the base.
                const top = bottom>=height && tag?.part && !tag.measured ? bottom+height : height;
                if(bottom>=top)continue;
                const roof = points.map(p => world(p.x, p.y, z, x, y, extent, top));
                const roofTint = tag?.color || color;
                if(tag?.color)roofUv[1]=-2;
                // OpenMapTiles assigns a nominal low extrusion where height
                // is missing. Only these flat, untagged footprints are eligible
                // for independent airborne observations.
                else if(!tag && !bottom && [5,6].includes(top))roofUv[1]=-.5;
                const wallFamily = !tag ? family : tag.plain || tag.part && [9,10].includes(tag.shape) ? 3 :
                    tag.wallClass===7 ? 2 : tag.wallClass ? 1 : family;
                const wallSeed=(seed & ~3)+wallFamily;
                const metresPerUnit = tag && TAU * R / (2 ** z * extent * Math.cosh(Math.PI * (1 - 2 * (y + center[1]) / 2 ** z)));
                // A clipped outline has lost the position of its ridge. Buffered
                // outlines wholly inside the MVT remain suitable across tile edges.
                const complete = tag && minX > -extent / 128 && minY > -extent / 128 &&
                    maxX < extent * (1 + 1 / 128) && maxY < extent * (1 + 1 / 128);
                const shaped = complete && roofShapes.buildRoof(tag,rings,points,indices,top,bottom,metresPerUnit);
                if (shaped) {
                    shapedRoofs++;
                    for (const face of shaped.faces) {
                        const coords=face.map(p=>world(p.x,p.y,z,x,y,extent,p.z));
                        const ab=coords[1].map((v,i)=>v-coords[0][i]),ac=coords[2].map((v,i)=>v-coords[0][i]);
                        const n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
                        const length=Math.hypot(...n);
                        if(length<1e-8)continue;
                        const reverse=n.reduce((sum,v,i)=>sum+v*coords[0][i],0)<0;
                        const normal=n.map(v=>Math.round(v/length*(reverse?-32767:32767)));
                        reserve(3);
                        const first=pos.length/3;
                        for(let j=0;j<3;j++)vertex(coords[j],normal,roofUv,center,roofTint,seed,face[j]);
                        if(reverse)index.push(first,first+2,first+1);
                        else index.push(first,first+1,first+2);
                    }
                } else {
                // Earcut indexes are local to the roof. Keep each corner once while preserving
                // separate wall normals and restarting the remap at a 16-bit batch boundary.
                const roofVertex = [];
                for (let k = 0; k < indices.length; k += 3) {
                    const a = indices[k],
                        b = indices[k + 1],
                        c = indices[k + 2];
                    const winding =
                        (points[b].x - points[a].x) * (points[c].y - points[a].y) -
                        (points[b].y - points[a].y) * (points[c].x - points[a].x);
                    if (winding === 0) continue;
                    if (pos.length / 3 + 3 > 65535) {
                        flush();
                        roofVertex.length = 0;
                    }
                    for (let j = k; j < k + 3; j++) {
                        const id = indices[j];
                        if (roofVertex[id] === undefined) {
                            roofVertex[id] = pos.length / 3;
                            const radial = roof[id].map(v =>
                                Math.round((v * 32767) / (R + top))
                            );
                            vertex(roof[id], radial, roofUv, center, roofTint, seed, points[id]);
                        }
                    }
                    if (winding > 0) index.push(roofVertex[a], roofVertex[c], roofVertex[b]);
                    else index.push(roofVertex[a], roofVertex[b], roofVertex[c]);
                }
                }
                let ringOffset = 0;
                const exteriorSign = Math.sign(signedArea(outer));
                for (const ring of shaped ? shaped.walls : rings) {
                    let along = 0;
                    for (let j = 0; j < ring.length; j++) {
                        const a = ring[j],
                            b = ring[(j + 1) % ring.length];
                        const ha=shaped?a.z:top,hb=shaped?b.z:top;
                        const qa = shaped ? world(a.x,a.y,z,x,y,extent,ha) : roof[ringOffset + j],
                            qb = shaped ? world(b.x,b.y,z,x,y,extent,hb) : roof[ringOffset + ((j + 1) % ring.length)],
                            pa = qa.map(v => v * ((R+bottom)/(R+ha))),
                            pb = qb.map(v => v * ((R+bottom)/(R+hb)));
                        const length = Math.hypot(...pb.map((v, k) => v - pa[k]));
                        const edge = pb.map((v, k) => v - pa[k]),
                            invRadius = 1 / Math.hypot(...pa),
                            up = pa.map(v => v * invRadius);
                        // MVT exterior winding is clockwise when viewed from above the globe.
                        const desired = [
                            up[1] * edge[2] - up[2] * edge[1],
                            up[2] * edge[0] - up[0] * edge[2],
                            up[0] * edge[1] - up[1] * edge[0]
                        ].map(v => v * exteriorSign);
                        quad(
                            [pa, pb, qb, qa],
                            [
                                [along, bottom],
                                [along + length, bottom],
                                [along + length, hb],
                                [along, ha]
                            ],
                            center,
                            tag?.wallColor||color,
                            wallSeed,
                            [a, b, b, a],
                            desired
                        );
                        along += length;
                    }
                    ringOffset += ring.length;
                }
                count++;
            }
        }
        flush();
    }
    return { origin, count, shapedRoofs, chunks, water:includeWater?water.waterMask(layers.water, layers.transportation):undefined };
}
