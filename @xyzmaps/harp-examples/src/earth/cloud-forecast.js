// Own the forecast texture separately from the historical coverage texture.
// Worker termination cancels downloads and bounds state across rapid changes.
function createForecast(THREE, map, uniforms, status, cloudSystem, historical, placeholder) {
    let worker, cached, requested = false, valid = 0;
    function stop() {
        worker?.terminate();
        worker = undefined;
    }
    function setPreset(id) {
        requested = id === "forecast";
        stop();
        uniforms.cloudMap.value = historical() || placeholder;
        status.cloudReady = !!historical();
        status.forecast = "";
        if (!requested) {
            cloudSystem.setPreset(id);
            return;
        }
        function apply() {
            uniforms.cloudMap.value = cached;
            status.cloudReady = true;
            status.forecast = "NOAA GFS · " + new Date(valid).toISOString().slice(0,16).replace("T"," ") + " UTC";
            cloudSystem.setPreset(-1);
        }
        if (cached && Math.abs(Date.now() - valid) <= 90 * 60000) {
            apply();
            return;
        }
        cloudSystem.setPreset(0);
        status.forecast = "Loading global forecast…";
        function unavailable() {
            stop();
            status.forecast = historical() ? "Forecast unavailable. Showing historical coverage." : "Cloud coverage unavailable.";
            map.update();
        }
        try {worker = new Worker(require("./worker-url").earthWorkerUrl("earth-weather"));} catch {unavailable();return;}
        worker.onerror = unavailable;
        worker.onmessage = ({data}) => {
            stop();
            if (data.error) {unavailable();return;}
            cached?.dispose();
            cached = new THREE.DataTexture(data.rgba, data.width, data.height, THREE.RGBAFormat);
            cached.wrapS = THREE.RepeatWrapping;
            cached.magFilter = THREE.LinearFilter;
            cached.minFilter = THREE.LinearMipmapLinearFilter;
            cached.generateMipmaps = true;
            cached.needsUpdate = true;
            valid = data.valid;
            apply();
        };
        worker.postMessage(null);
    }
    return {
        setPreset,
        get active() {return requested && uniforms.cloudPreset.value < 0;},
        dispose() {
            stop();
            uniforms.cloudMap.value = historical() || placeholder;
            cached?.dispose();
        }
    };
}
module.exports = { createForecast };
