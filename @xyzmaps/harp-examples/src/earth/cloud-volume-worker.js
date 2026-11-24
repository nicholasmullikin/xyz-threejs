// Reproduce the offline volume exactly on a background thread. Transfer the
// typed array once, then the caller terminates this worker.
const { generateVolume } = require("./cloud-noise");
self.onmessage = () => {
    const data = generateVolume();
    self.postMessage(data, [data.buffer]);
};
