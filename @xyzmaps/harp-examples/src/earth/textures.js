/** Abortable image loading. Texture ownership transfers to the successful caller. */
function createTextureLoader(THREE) {
    const requests = new Set();
    let disposed = false;
    return {
        load(url, onLoad, _progress, onError = () => {}) {
            if (disposed) return;
            const controller = new AbortController(),
                request = { controller, image: null };
            requests.add(request);
            let objectUrl;
            fetch(url, { signal: controller.signal })
                .then(response => {
                    if (!response.ok)
                        throw Error(`Texture request failed: HTTP ${response.status}`);
                    return response.blob();
                })
                .then(
                    blob =>
                        new Promise((resolve, reject) => {
                            if (disposed) {
                                reject(new DOMException("Cancelled", "AbortError"));
                                return;
                            }
                            const image = (request.image = new Image());
                            image.onload = () => resolve(image);
                            image.onerror = () => reject(Error("Texture image decoding failed"));
                            objectUrl = URL.createObjectURL(blob);
                            image.src = objectUrl;
                        })
                )
                .then(image => {
                    if (disposed) return;
                    const texture = new THREE.Texture(image);
                    texture.needsUpdate = true;
                    onLoad(texture);
                })
                .catch(error => {
                    if (!disposed && error.name !== "AbortError") onError(error);
                })
                .finally(() => {
                    requests.delete(request);
                    if (objectUrl) URL.revokeObjectURL(objectUrl);
                });
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const request of requests) {
                request.controller.abort();
                if (request.image) {
                    request.image.onerror?.();
                    request.image.onload = null;
                    request.image.onerror = null;
                    request.image.src = "";
                }
            }
            requests.clear();
        }
    };
}
module.exports = { createTextureLoader };
