// A global Black Marble overview remains available while one overlapping,
// native-resolution window is fetched for a close night view.
function pageFor(latitude, longitude) {
    const u = (longitude + 180) / 360;
    const col = ((Math.round(u * 16) % 16) + 16) % 16;
    const row = Math.max(1, Math.min(7, Math.round(((90 - latitude) / 180) * 8)));
    return { key: col + "-" + row, x: col / 16, y: 1 - row / 8 };
}
function scalarFormat(THREE, renderer, texture) {
    // The shaders read only red. WebGL 1 expands LUMINANCE to RGB on sampling.
    texture.format = renderer.capabilities.isWebGL2 ? THREE.RedFormat : THREE.LuminanceFormat;
    texture.needsUpdate = true;
}
function createNightDetail(THREE, map, sky, loader, uniforms, status) {
    let displayed,
        next,
        pending,
        cancel,
        desired,
        eligibleAt = 0,
        retryAt = 0,
        wake,
        last = 0;
    const up = new THREE.Vector3();
    function scheduleWake(deadline) {
        clearTimeout(wake);
        wake = setTimeout(() => map.update(), Math.max(0, Math.ceil(deadline - performance.now())));
    }
    function update(mode, now) {
        const target = map.target;
        let page;
        if (mode === "a" && uniforms.lightsEnabled.value && map.zoomLevel >= 7 && target) {
            const lat = (target.latitude * Math.PI) / 180,
                lon = (target.longitude * Math.PI) / 180;
            up.set(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
            if (up.dot(sky.uniforms.sunDirection.value) < 0.18)
                page = pageFor(target.latitude, target.longitude);
        }
        if (desired !== page?.key) {
            desired = page?.key;
            eligibleAt = now + 160;
            retryAt = 0;
            clearTimeout(wake);
            if (page && page.key !== displayed?.key) scheduleWake(eligibleAt);
            if (pending !== desired) {
                cancel?.();
                cancel = undefined;
                pending = undefined;
            }
            if (next && next.key !== desired) {
                next.texture.dispose();
                next = undefined;
            }
        }
        if (
            page &&
            page.key !== displayed?.key &&
            !next &&
            !pending &&
            now >= Math.max(eligibleAt, retryAt)
        ) {
            const key = page.key;
            pending = key;
            status.nightPageRequests++;
            cancel = loader.load(
                "resources/earth/night/" + key + ".webp",
                texture => {
                    if (desired !== key) {
                        texture.dispose();
                        return;
                    }
                    pending = undefined;
                    cancel = undefined;
                    scalarFormat(THREE, map.renderer, texture);
                    next = { ...page, texture };
                    map.update();
                },
                undefined,
                () => {
                    pending = undefined;
                    cancel = undefined;
                    if (desired !== key) return;
                    retryAt = performance.now() + 30000;
                    scheduleWake(retryAt);
                },
                { bitmap: true }
            );
        }
        const blend = uniforms.nightDetailFade;
        const step = Math.min(1, Math.max(0, now - last) / 350);
        last = now;
        const goal = displayed && (displayed.key === desired || (desired && !next)) ? 1 : 0;
        blend.value += Math.sign(goal - blend.value) * Math.min(step, Math.abs(goal - blend.value));
        if (blend.value === 0 && displayed && displayed.key !== desired) {
            displayed.texture.dispose();
            displayed = undefined;
            uniforms.nightDetailMap.value = null;
        }
        if (!displayed && next) {
            displayed = next;
            next = undefined;
            uniforms.nightDetailMap.value = displayed.texture;
            uniforms.nightCenter.value.set(displayed.x, displayed.y);
            map.update();
        }
        status.nightPage = displayed?.key;
        if (blend.value !== goal) map.update();
    }
    return {
        update,
        dispose() {
            desired = undefined;
            clearTimeout(wake);
            cancel?.();
            next?.texture.dispose();
            displayed?.texture.dispose();
        }
    };
}
module.exports = { pageFor, scalarFormat, createNightDetail };
