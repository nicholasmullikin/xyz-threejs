// Native blob transfer reports byte progress without copying every response
// chunk through JavaScript. A slowly advancing connection can take any length
// of time; the caller's watchdog only expires after a period of silence.
function rasterBlob(url, signal, progress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        xhr.open("GET", url);
        xhr.responseType = "blob";
        xhr.onprogress = progress;
        xhr.onreadystatechange = () => {
            if (xhr.readyState !== 2) return;
            progress();
            if (xhr.status < 300) return;
            const headers = new Headers();
            for (const line of xhr
                .getAllResponseHeaders()
                .trim()
                .split(/[\r\n]+/)) {
                const split = line.indexOf(":");
                if (split > 0) headers.append(line.slice(0, split), line.slice(split + 1).trim());
            }
            reject(httpError(xhr.status, headers));
            xhr.abort();
        };
        xhr.onload = () => resolve(xhr.response);
        xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
        xhr.onerror = () => reject(new Error("Raster transfer failed"));
        xhr.onloadend = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        xhr.send();
    });
}
function httpError(status, headers) {
    return Object.assign(Error(`Texture request failed: HTTP ${status}`), {
        status,
        retryMs: require("./imagery-backoff").retryDelay(headers, status)
    });
}
module.exports = { rasterBlob, httpError };
