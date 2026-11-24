// Reuse a stationary cloud frame briefly while the slow wind moves by less
// than the raymarch's spatial resolution. Any camera, lighting, source or
// quality change invalidates it immediately.
function createCloudReuse(intervalMs = 120) {
    let snapshot;
    const version = texture => texture?.version ?? 0;
    function equal(a, b) {
        return !!a && !!b && a.equals(b);
    }
    function canReuse(state, now) {
        const s = snapshot;
        return (
            !!s &&
            now >= s.now &&
            now - s.now < intervalMs &&
            Math.abs(state.time - s.time) < intervalMs / 1000 &&
            state.width === s.width &&
            state.height === s.height &&
            state.steps === s.steps &&
            state.preset === s.preset &&
            state.coverage === s.coverage &&
            state.noise === s.noise &&
            version(state.coverage) === s.coverageVersion &&
            version(state.noise) === s.noiseVersion &&
            equal(state.camera, s.camera) &&
            equal(state.rotation, s.rotation) &&
            equal(state.projection, s.projection) &&
            equal(state.sun, s.sun)
        );
    }
    function record(state, now) {
        if (!snapshot)
            snapshot = {
                camera: state.camera.clone(),
                rotation: state.rotation.clone(),
                projection: state.projection.clone(),
                sun: state.sun.clone()
            };
        const s = snapshot;
        s.camera.copy(state.camera);
        s.rotation.copy(state.rotation);
        s.projection.copy(state.projection);
        s.sun.copy(state.sun);
        Object.assign(s, {
            now,
            time: state.time,
            width: state.width,
            height: state.height,
            steps: state.steps,
            preset: state.preset,
            coverage: state.coverage,
            noise: state.noise,
            coverageVersion: version(state.coverage),
            noiseVersion: version(state.noise)
        });
    }
    return {
        canReuse,
        record,
        invalidate() {
            snapshot = undefined;
        }
    };
}
module.exports = { createCloudReuse };
