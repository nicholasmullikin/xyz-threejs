// Build the Earth example from workspace source into an isolated, verifiable asset set.
const fs = require("node:fs"),
    path = require("node:path"),
    crypto = require("node:crypto"),
    { execFileSync } = require("node:child_process"),
    { createRequire } = require("node:module");
const root = path.resolve(__dirname, ".."),
    examples = path.join(root, "@xyzmaps/harp-examples"),
    req = createRequire(path.join(examples, "package.json")),
    webpack = req("webpack");
const destination = path.resolve(process.argv[2] || path.join(root, "dist/earth"));
const aliases = { three: path.dirname(path.dirname(req.resolve("three"))) };
for (const name of fs.readdirSync(path.join(root, "@xyzmaps"))) {
    const dir = path.join(root, "@xyzmaps", name);
    if (fs.existsSync(path.join(dir, "index.ts"))) aliases["@xyzmaps/" + name] = dir;
}
const common = {
    mode: "development",
    devtool: "source-map",
    context: root,
    resolve: {
        extensions: [".ts", ".tsx", ".mjs", ".js"],
        alias: aliases,
        fallback: { fs: false }
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: {
                    loader: req.resolve("ts-loader"),
                    options: {
                        transpileOnly: true,
                        configFile: path.join(examples, "tsconfig.earth.json")
                    }
                }
            }
        ]
    },
    optimization: { minimize: false },
    output: { path: destination },
    stats: { all: false, errors: true, warnings: true, assets: true }
};
const configs = [
    {
        ...common,
        name: "browser",
        target: "web",
        entry: path.join(examples, "src/rendering_globe-atmosphere.ts"),
        output: { ...common.output, filename: "rendering_globe-atmosphere_bundle.js" }
    },
    {
        ...common,
        name: "worker",
        target: "webworker",
        entry: path.join(examples, "decoder/decoder.ts"),
        output: { ...common.output, filename: "decoder.bundle.js" }
    }
];
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
webpack(configs, (error, stats) => {
    if (error || stats.hasErrors()) {
        console.error(error || stats.toString());
        process.exitCode = 1;
        return;
    }
    fs.mkdirSync(path.join(destination, "resources/earth"), { recursive: true });
    const source = path.join(examples, "src/earth");
    require("./build-cloud-noise.cjs").build(path.join(source, "resources/cloud-noise.png"));
    fs.cpSync(path.join(source, "resources"), path.join(destination, "resources/earth"), {
        recursive: true
    });
    fs.copyFileSync(
        path.join(source, "earth-theme.json"),
        path.join(destination, "resources/earth-theme.json")
    );
    const html =
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Interactive Earth</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:black}#mapCanvas{width:100%;height:100%;position:absolute;inset:0}#copyrightNotice{display:none}</style><script defer src="rendering_globe-atmosphere_bundle.js"></script></head><body><canvas id="mapCanvas"></canvas><div id="app"></div><div id="copyrightNotice"></div></body></html>\n';
    fs.writeFileSync(path.join(destination, "rendering_globe-atmosphere.html"), html);
    const licenses = ["@mapbox/vector-tile", "@mapbox/point-geometry", "pbf", "earcut"]
        .map(name => {
            let dir = path.dirname(req.resolve(name));
            while (!fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
            const file = ["LICENSE", "LICENSE.txt", "LICENSE.md"]
                .map(f => path.join(dir, f))
                .find(f => fs.existsSync(f));
            return name + "\n" + fs.readFileSync(file, "utf8");
        })
        .join("\n\n");
    fs.writeFileSync(path.join(destination, "earth-buildings-worker.LICENSE.txt"), licenses);
    const inputs = {};
    for (const compilation of stats.stats)
        for (const file of compilation.compilation.fileDependencies) {
            if (
                file.startsWith(root + path.sep) &&
                !file.includes("/node_modules/") &&
                fs.statSync(file).isFile()
            )
                inputs[path.relative(root, file)] = sha(fs.readFileSync(file));
        }
    for (const file of [
        "yarn.lock",
        "scripts/build-earth.cjs",
        "scripts/build-cloud-noise.cjs",
        "@xyzmaps/harp-examples/src/earth/cloud-noise.js",
        "@xyzmaps/harp-examples/tsconfig.earth.json",
        "@xyzmaps/harp-examples/src/earth/earth-theme.json"
    ])
        inputs[file] = sha(fs.readFileSync(path.join(root, file)));
    for (const file of fs.readdirSync(path.join(source, "resources")))
        inputs["@xyzmaps/harp-examples/src/earth/resources/" + file] = sha(
            fs.readFileSync(path.join(source, "resources", file))
        );
    const walk = dir =>
        fs
            .readdirSync(dir, { withFileTypes: true })
            .flatMap(e =>
                e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
            );
    const assets = Object.fromEntries(
        walk(destination)
            .filter(f => !f.endsWith("earth-build.json"))
            .sort()
            .map(f => [path.relative(destination, f), sha(fs.readFileSync(f))])
    );
    const sortedInputs = Object.fromEntries(
        Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))
    );
    const manifest = {
        format: 1,
        sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8"
        }).trim(),
        lockHash: sha(fs.readFileSync(path.join(root, "yarn.lock"))),
        inputHash: sha(JSON.stringify(sortedInputs)),
        inputs: sortedInputs,
        assets
    };
    fs.writeFileSync(
        path.join(destination, "earth-build.json"),
        JSON.stringify(manifest, null, 2) + "\n"
    );
    console.log(stats.toString());
    console.log("Verified Earth build:", destination, "input", manifest.inputHash);
});
