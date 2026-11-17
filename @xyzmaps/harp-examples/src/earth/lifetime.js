/** Owns callbacks and timers that must not outlive a map. */
function createLifetime() {
    let disposed = false;
    const cleanup = new Set();
    const own = fn => {
        if (disposed) fn();
        else cleanup.add(fn);
        return fn;
    };
    return {
        get disposed() {
            return disposed;
        },
        own,
        listen(target, type, listener, options) {
            target.addEventListener(type, listener, options);
            own(() => target.removeEventListener(type, listener, options));
        },
        timeout(fn, delay) {
            const cancel = () => clearTimeout(id);
            const id = setTimeout(() => {
                cleanup.delete(cancel);
                if (!disposed) fn();
            }, delay);
            own(cancel);
            return id;
        },
        interval(fn, delay) {
            const id = setInterval(() => {
                if (!disposed) fn();
            }, delay);
            own(() => clearInterval(id));
            return id;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const fn of [...cleanup].reverse()) fn();
            cleanup.clear();
        }
    };
}
module.exports = { createLifetime };
