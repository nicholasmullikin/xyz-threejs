// The generated HTML pins workers to the same build as its scripts. Old HTML
// and standalone consumers continue to use the revalidated legacy path.
function earthWorkerUrl(name) {
    if (!/^earth-[a-z0-9-]+$/.test(name)) throw new Error("Invalid Earth worker name");
    const meta =
        typeof document === "undefined"
            ? null
            : document.querySelector?.(`meta[name="earth-worker-${name}"]`);
    const value = meta?.content;
    return value && new RegExp(`^${name}\\.[a-f0-9]{12}\\.js$`).test(value)
        ? value
        : `${name}.bundle.js`;
}
module.exports = { earthWorkerUrl };
