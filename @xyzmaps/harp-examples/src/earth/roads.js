// Optional, illustrative night-road masks. No work or fetch occurs while off,
// in daylight, outside the close regional view, or in a hidden document.
const SIZE = 256, GRID = 3, CACHE_LIMIT = 20, META_URL = "https://tiles.openfreemap.org/planet";
function mercator(latitude, longitude, z) {
    const n = 2 ** z, lat = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180;
    return { x: Math.floor((((longitude + 180) / 360) % 1 + 1) % 1 * n),
        y: Math.max(0, Math.min(n-1, Math.floor((1-Math.asinh(Math.tan(lat))/Math.PI)*.5*n))) };
}
function targetIsDark(target, sun) {
    const lat=target.latitude*Math.PI/180, lon=target.longitude*Math.PI/180, c=Math.cos(lat);
    return c*Math.cos(lon)*sun.x+c*Math.sin(lon)*sun.y+Math.sin(lat)*sun.z < .025;
}
function createRoads(THREE, map, sky, environment) {
    const supported = map.renderer.capabilities.maxTextures >= 9 && typeof Worker !== "undefined";
    const cache = new Map(), pendingWorker = new Map(), boundMaterials = new Map(), stats = { enabled:false, active:false, supported, requests:0, uploads:0, failures:0, features:0, cache:0 };
    let disposed=false, worker, controller, metadata, metadataPromise, generation=0, atlas, desired, serial=0, timer=0, retryAfter=0;
    function stop(clearCache=false) {
        generation++;
        controller?.abort(); controller=undefined; metadataPromise=undefined;
        clearTimeout(timer); timer=0;
        if (worker) { worker.terminate(); worker=undefined; }
        for (const item of pendingWorker.values()) item.reject(new Error("Road decode cancelled"));
        pendingWorker.clear();
        for (const [material, state] of boundMaterials) {
            material.removeEventListener?.("dispose", state.listener);
            disableMaterial(material);
        }
        boundMaterials.clear();
        if (atlas) { atlas.texture.dispose(); atlas=undefined; }
        desired=undefined; stats.active=false; stats.features=0;
        if (clearCache) cache.clear();
        stats.cache=cache.size;
    }
    function getWorker() {
        if (worker) return worker;
        worker=new Worker(new URL(require("./worker-url").earthWorkerUrl("earth-road-worker"),document.baseURI));
        worker.onmessage=event=>{
            const result=event.data, item=pendingWorker.get(result.id);
            if (!item) return;
            pendingWorker.delete(result.id);
            if (result.error) item.reject(new Error(result.error)); else item.resolve(result);
        };
        worker.onerror=()=>{
            for (const item of pendingWorker.values()) item.reject(new Error("Road worker failed"));
            pendingWorker.clear();
            worker?.terminate(); worker=undefined;
        };
        return worker;
    }
    async function template(signal) {
        if (metadata) return metadata;
        if (!metadataPromise) metadataPromise=(async()=>{
            const response=await fetch(META_URL,{signal});
            if (!response.ok) throw new Error(`Road metadata HTTP ${response.status}`);
            const data=await response.json();
            if (!Array.isArray(data.tiles) || typeof data.tiles[0] !== "string") throw new Error("Invalid road metadata");
            return (metadata=data.tiles[0]);
        })();
        const promise=metadataPromise;
        try { return await promise; }
        finally { if (metadataPromise===promise) metadataPromise=undefined; }
    }
    async function tile(z,x,y,signal) {
        const n=2**z;
        if (y<0 || y>=n) return {mask:new Uint8Array(SIZE*SIZE),features:0};
        x=((x%n)+n)%n;
        const key=`${z}/${x}/${y}`, cached=cache.get(key);
        if (cached) { cache.delete(key); cache.set(key,cached); return cached; }
        const url=(await template(signal)).replace("{z}",z).replace("{x}",x).replace("{y}",y);
        if (signal.aborted) throw new Error("Road request cancelled");
        stats.requests++;
        const response=await fetch(url,{signal});
        if (!response.ok) {
            if (response.status===404 || response.status===410) return {mask:new Uint8Array(SIZE*SIZE),features:0};
            throw new Error(`Road tile HTTP ${response.status}`);
        }
        const buffer=await response.arrayBuffer();
        if (signal.aborted) throw new Error("Road request cancelled");
        const id=++serial, result=await new Promise((resolve,reject)=>{
            pendingWorker.set(id,{resolve,reject});
            try { getWorker().postMessage({id,buffer},[buffer]); }
            catch (error) { pendingWorker.delete(id); reject(error); }
        });
        if (signal.aborted) throw new Error("Road request cancelled");
        cache.set(key,result);
        while(cache.size>CACHE_LIMIT) cache.delete(cache.keys().next().value);
        stats.cache=cache.size;
        return result;
    }
    async function refresh(z,x,y) {
        controller?.abort(); metadataPromise=undefined; controller=new AbortController();
        const signal=controller.signal, revision=++generation;
        const jobs=[];
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) jobs.push({x:x+dx,y:y+dy});
        const result=new Array(jobs.length); let next=0;
        try {
            await Promise.all(Array.from({length:3},async()=>{
                while(next<jobs.length) { const i=next++, p=jobs[i]; result[i]=await tile(z,p.x,p.y,signal); }
            }));
            if(disposed || signal.aborted || revision!==generation) return;
            const width=SIZE*GRID, bytes=new Uint8Array(width*width);
            let features=0;
            for(let i=0;i<jobs.length;i++) {
                const source=result[i].mask, ox=(i%GRID)*SIZE, oy=Math.floor(i/GRID)*SIZE;
                features+=result[i].features;
                for(let row=0;row<SIZE;row++) bytes.set(source.subarray(row*SIZE,(row+1)*SIZE),(oy+row)*width+ox);
            }
            const texture=new THREE.DataTexture(bytes,width,width,map.renderer.capabilities.isWebGL2?THREE.RedFormat:THREE.LuminanceFormat);
            texture.minFilter=texture.magFilter=THREE.LinearFilter; texture.generateMipmaps=false;
            texture.unpackAlignment=1; texture.needsUpdate=true;
            const previous=atlas;
            atlas={texture,z,x:x-1,y:y-1};
            stats.uploads++; stats.features=features; stats.active=true;
            // The result arrives asynchronously. Bind already-visible terrain
            // immediately so the redraw cannot race an earlier tile update.
            for (const [material, state] of boundMaterials) bind(material,state.key,state.roadSlots);
            previous?.texture.dispose();
            map.update();
        } catch(_error) {
            if (!signal.aborted && revision===generation && !disposed) {
                stats.failures++; retryAfter=performance.now()+10000; desired=undefined;
                timer=setTimeout(()=>{ timer=0; if(!disposed)map.update(); },10000);
            }
        }
    }
    function update(mode) {
        // Disabled is the default and must not inspect camera/target each frame.
        if (!stats.enabled || !supported) return;
        const target=map.target, altitude=map.camera.position.length()/1000-6378.137;
        const active=mode==="a" && !document.hidden && environment.uniforms.lightsEnabled.value>0 &&
            altitude>.25 && altitude<18 && target && targetIsDark(target,sky.uniforms.sunDirection.value);
        if (!active) { if (desired || atlas || worker) stop(); return; }
        // A fixed atlas remains aligned during a pan. Replan after movement
        // settles instead of aborting and restarting nine tiles every frame.
        if (map.cameraIsMoving) return;
        const z=altitude>5?13:14, p=mercator(target.latitude,target.longitude,z), key=`${z}/${p.x}/${p.y}`;
        if (key===desired || performance.now()<retryAfter) return;
        desired=key;
        void refresh(z,p.x,p.y);
    }
    function disableMaterial(material) {
        if (!material.defines.EARTH_STYLIZED_ROADS) return;
        delete material.defines.EARTH_STYLIZED_ROADS;
        material.defines.EARTH_DETAIL_SLOTS=material.userData.roadBaseSlots;
        material.uniforms.roadAtlas.value=null;
        material.needsUpdate=true;
    }
    function bind(material,key,roadSlots) {
        const enabled=!!atlas && stats.enabled && stats.active && supported;
        const defines=material.defines;
        if (stats.enabled) {
            let state=boundMaterials.get(material);
            if (!state) {
                const listener=()=>boundMaterials.delete(material);
                state={listener,key,roadSlots};
                boundMaterials.set(material,state);
                material.addEventListener?.("dispose",listener);
            } else { state.key=key; state.roadSlots=roadSlots; }
        }
        if (!enabled) { disableMaterial(material); return; }
        const base=material.userData.roadBaseSlots ??= defines.EARTH_DETAIL_SLOTS;
        const slots=Number.isInteger(roadSlots)?Math.max(0,Math.min(base,roadSlots)):Math.max(0,base-1);
        if (!defines.EARTH_STYLIZED_ROADS || defines.EARTH_DETAIL_SLOTS!==slots) {
            defines.EARTH_STYLIZED_ROADS=1; defines.EARTH_DETAIL_SLOTS=slots;
            material.needsUpdate=true;
        }
        const scale=2**(atlas.z-key.level), n=2**atlas.z, raw=key.column*scale-atlas.x;
        const dx=((raw+n/2)%n+n)%n-n/2;
        material.uniforms.roadAtlas.value=atlas.texture;
        material.uniforms.roadUv.value.set(scale/GRID,-scale/GRID,dx/GRID,((key.row+1)*scale-atlas.y)/GRID);
    }
    function visibility() {
        if (document.hidden) stop();
        else if (stats.enabled) map.update();
    }
    function setEnabled(value) {
        if (disposed) return;
        const enabled=!!value&&supported;
        if (enabled===stats.enabled) return;
        stats.enabled=enabled;
        if (enabled) document.addEventListener?.("visibilitychange",visibility);
        else { document.removeEventListener?.("visibilitychange",visibility); stop(true); }
        map.update();
    }
    function dispose() {
        if(disposed)return;
        disposed=true;
        document.removeEventListener?.("visibilitychange",visibility);
        stop(true);
    }
    return { stats, update, bind, setEnabled, dispose };
}
module.exports = { createRoads, mercator, targetIsDark };
