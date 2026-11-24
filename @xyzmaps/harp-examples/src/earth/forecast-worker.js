// GFS atmospheric single-level products are public on S3. Request only
// the three GRIB records identified by the run's inventory.
const { decodeCloudGrid, width, height } = require("./forecast-grid");
const hour = 3600000, base = "https://noaa-gfs-bdp-pds.s3.amazonaws.com";
async function readLayer(url, start, end, signal) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
        end <= start || end - start > 300000) throw Error("Invalid GFS byte range");
    const response = await fetch(url, {headers:{Range:"bytes=" + start + "-" + (end-1)}, signal});
    // Refuse a server's full forecast (tens of MB) if it ignores Range.
    if (response.status !== 206) {
        await response.body?.cancel();
        throw Error("GFS range unavailable");
    }
    const data = await response.arrayBuffer();
    if (data.byteLength !== end - start) throw Error("Incomplete GFS field");
    return decodeCloudGrid(data);
}
async function loadRun(cycle, valid) {
    const time = new Date(cycle).toISOString(), date = time.slice(0,10).replaceAll("-","");
    const run = time.slice(11,13), step = String((valid-cycle)/hour).padStart(3,"0");
    const url = base + "/gfs." + date + "/" + run + "/atmos/gfs.t" + run + "z.pgrb2.1p00.f" + step;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 16000);
    try {
        const index = await fetch(url + ".idx", {signal:controller.signal});
        if (!index.ok) throw Error("Forecast unavailable");
        const text = await index.text();
        if (text.length > 131072) throw Error("Unexpected GFS inventory");
        const rows = text.trim().split(/\r?\n/).map(row => row.split(":"));
        const fields = await Promise.all([["LCDC","low"],["MCDC","middle"],["HCDC","high"]].map(([code, layer]) => {
            const i = rows.findIndex(row => row[3] === code && row[4] === layer + " cloud layer" &&
                row[5] === Number(step) + " hour fcst");
            if (i < 0 || !rows[i+1]) throw Error("Cloud layer unavailable");
            return readLayer(url, Number(rows[i][1]), Number(rows[i+1][1]), controller.signal);
        }));
        return makeTexture(fields);
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}
function makeTexture(fields) {
    // Power-of-two rows allow mipmaps and continuous longitude wrapping on WebGL 1.
    // Source is north-first at 0E; GL row zero is the southern edge at 180W.
    const w = 512, h = 256, rgba = new Uint8Array(w*h*4);
    for (let y=0; y<h; y++) {
        const sy=(1-(y+.5)/h)*(height-1), y0=Math.floor(sy), fy=sy-y0;
        for (let x=0; x<w; x++) {
            const sx=((x+.5)*width/w + width/2)%width, x0=Math.floor(sx), fx=sx-x0;
            const a=y0*width+x0, b=y0*width+(x0+1)%width, out=(y*w+x)*4;
            for(let i=0;i<3;i++){
                const f=fields[i], lower=f[a]*(1-fx)+f[b]*fx, upper=f[a+width]*(1-fx)+f[b+width]*fx;
                rgba[out+i]=Math.round(lower*(1-fy)+upper*fy);
            }
            rgba[out+3]=255;
        }
    }
    return {width:w,height:h,rgba};
}
async function forecast(now) {
    const valid = Math.round(now/(3*hour))*3*hour;
    const newest = Math.floor((now-5*hour)/(6*hour))*6*hour;
    for(const cycle of [newest,newest-6*hour]) {
        try {return {...await loadRun(cycle,valid),valid,cycle}} catch (error) {
            if(cycle !== newest)throw error;
        }
    }
}
if(typeof self !== "undefined") self.onmessage = async () => {
    try {
        const result = await forecast(Date.now());
        self.postMessage(result,[result.rgba.buffer]);
    } catch {self.postMessage({error:"NOAA forecast unavailable"});}
};
module.exports={forecast,makeTexture,loadRun};
