// OpenMapTiles transportation lines -> a compact, antialiased 256² mask.
// A mask is an illustrative road highlight, not a map of actual lamps.
import { VectorTile } from "@mapbox/vector-tile";
import Pbf from "pbf";
const SIZE = 256;
const strengths = { motorway: 255, trunk: 245, primary: 225, secondary: 205, tertiary: 180 };
export function roadStrength(properties) {
    const strength = strengths[properties.class] || 0;
    if (!strength || properties.brunnel === "tunnel" || properties.brunnel === "bridge" ||
        properties.surface === "unpaved" || properties.indoor || properties.lit === "no" ||
        properties.lit === false) return 0;
    return properties.lit === "yes" || properties.lit === true ? strength : Math.round(strength * .85);
}
function clip(x0, y0, x1, y1) {
    const dx = x1-x0, dy = y1-y0;
    let lo = 0, hi = 1;
    for (const [p, q] of [[-dx,x0+1],[dx,SIZE-x0],[-dy,y0+1],[dy,SIZE-y0]]) {
        if (p === 0) { if (q < 0) return; continue; }
        const r = q/p;
        if (p < 0) lo = Math.max(lo,r); else hi = Math.min(hi,r);
        if (lo > hi) return;
    }
    return [x0+lo*dx,y0+lo*dy,x0+hi*dx,y0+hi*dy];
}
function segment(mask, x0, y0, x1, y1, value) {
    const c = clip(x0,y0,x1,y1);
    if (!c) return;
    const [ax,ay,bx,by] = c, dx = bx-ax, dy = by-ay;
    const steps = Math.max(1,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))*2));
    for (let i=0;i<=steps;i++) {
        const x=ax+dx*i/steps, y=ay+dy*i/steps, ix=Math.floor(x), iy=Math.floor(y), fx=x-ix, fy=y-iy;
        for (let j=0;j<2;j++) for (let k=0;k<2;k++) {
            const px=ix+k, py=iy+j;
            if (px<0 || py<0 || px>=SIZE || py>=SIZE) continue;
            const weight=(k?fx:1-fx)*(j?fy:1-fy);
            const offset=py*SIZE+px;
            mask[offset]=Math.max(mask[offset],Math.round(value*weight));
        }
    }
}
export function rasterRoads(buffer) {
    const mask = new Uint8Array(SIZE*SIZE);
    if (!buffer.byteLength) return { mask, features: 0 };
    const layer = new VectorTile(new Pbf(buffer)).layers.transportation;
    if (!layer) return { mask, features: 0 };
    let features = 0;
    for (let i=0;i<layer.length;i++) {
        const feature=layer.feature(i), value=roadStrength(feature.properties);
        if (feature.type !== 2 || !value) continue;
        features++;
        const scale=SIZE/layer.extent;
        for (const line of feature.loadGeometry())
            for (let j=1;j<line.length;j++)
                segment(mask,line[j-1].x*scale,line[j-1].y*scale,line[j].x*scale,line[j].y*scale,value);
    }
    return { mask, features };
}
