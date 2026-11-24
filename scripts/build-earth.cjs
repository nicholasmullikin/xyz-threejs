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
    if (fs.existsSync(path.join(dir, "index.ts"))) {
        // Workspace packages may publish a separate browser entry. Resolve its
        // source as well, even before any package JS has been built.
        const browser = require(path.join(dir,"package.json")).browser;
        const browserSource = typeof browser === "string" && path.join(dir, browser.replace(/\.js$/, ".ts"));
        aliases["@xyzmaps/" + name] = browserSource && fs.existsSync(browserSource) ? browserSource : dir;
    }
}
const common = {
    mode: "production",
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
                        // Preserve ESM exports for webpack's package and worker tree shaking.
                        compilerOptions: { module: "ESNext" },
                        configFile: path.join(examples, "tsconfig.earth.json")
                    }
                }
            }
        ]
    },
    optimization: { minimize: true },
    output: { path: destination },
    stats: { all: false, errors: true, warnings: true, assets: true }
};
const configs = [
    {
        ...common,
        name: "browser",
        target: "web",
        entry: {
            "earth-background.bundle": path.join(examples, "src/earth/background.ts"),
            "rendering_globe-atmosphere_bundle": path.join(
                examples,
                "src/rendering_globe-atmosphere.ts"
            )
        },
        optimization: {
            minimize: true,
            splitChunks: {
                chunks: "initial",
                cacheGroups: {
                    default: false,
                    defaultVendors: false,
                    shared: {
                        name: "earth-shared",
                        filename: "earth-shared.[contenthash:12].js",
                        minChunks: 2,
                        enforce: true
                    }
                }
            }
        },
        output: {
            ...common.output,
            // The interactive entry is addressed by its content so returning
            // visitors can reuse it without a revalidation round trip. Both
            // entry points and their lazy chunks use content-addressed URLs.
            filename: pathData =>
                ["rendering_globe-atmosphere_bundle", "earth-background.bundle"].includes(pathData.chunk.name)
                    ? "[name].[contenthash:12].js"
                    : "[name].js",
            chunkFilename: "[name].[contenthash:12].js"
        }
    },
    {
        ...common,
        name: "earth-horizon",
        target: "webworker",
        entry: path.join(examples, "src/earth/terrain-horizon-worker.js"),
        output: { ...common.output, filename: "earth-horizon.[contenthash:12].js" }
    },
    {
        ...common,
        name: "earth-noise",
        target: "webworker",
        entry: path.join(examples, "src/earth/cloud-volume-worker.js"),
        output: { ...common.output, filename: "earth-noise.[contenthash:12].js" }
    },
    {
        ...common,
        name: "earth-bc7",
        target: "webworker",
        entry: path.join(examples, "src/earth/bc7-worker.js"),
        output: { ...common.output, filename: "earth-bc7.[contenthash:12].js" }
    },
    {
        ...common,
        name:"earth-lidar",
        target:"webworker",
        entry:path.join(examples,"src/earth/lidar-worker.js"),
        output:{...common.output,filename:"earth-lidar.[contenthash:12].js"}
    },
    {
        ...common,
        name: "earth-canopy",
        target: "webworker",
        entry: path.join(examples, "src/earth/canopy-worker.js"),
        output: { ...common.output, filename: "earth-canopy.[contenthash:12].js" }
    },
    {
        ...common,
        name: "earth-weather",
        target: "webworker",
        entry: path.join(examples, "src/earth/forecast-worker.js"),
        output: { ...common.output, filename: "earth-weather.[contenthash:12].js" }
    },
    {
        ...common,
        name: "earth-road-worker",
        target: "webworker",
        entry: path.join(examples, "src/earth/road-worker.mjs"),
        output: { ...common.output, filename: "earth-road-worker.[contenthash:12].js" }
    },
    {
        ...common,
        name: "earth-worker",
        target: "webworker",
        entry: path.join(examples, "src/earth/decoder.ts"),
        output: { ...common.output, filename: "earth-decoder.[contenthash:12].js" }
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
require("./build-atmosphere-lut.cjs").build();
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
    fs.copyFileSync(path.join(path.dirname(path.dirname(req.resolve("3d-tiles-renderer"))),"LICENSE"),path.join(destination,"resources/earth/survey-renderer-LICENSE.txt"));
    fs.copyFileSync(req.resolve("laz-perf/lib/web/laz-perf.wasm"),path.join(destination,"resources/earth/laz-perf.wasm"));
    const dracoDir = path.join(aliases.three,"examples/jsm/libs/draco/gltf");
    fs.mkdirSync(path.join(destination,"resources/earth/draco"), {recursive:true});
    for(const file of ["draco_decoder.wasm","draco_wasm_wrapper.js","draco_decoder.js"])
        fs.copyFileSync(path.join(dracoDir,file),path.join(destination,"resources/earth/draco",file));
    execFileSync(process.execPath, [
        path.join(root, "scripts/build-earth-environment.cjs"),
        path.join(source, "resources"),
        path.join(destination, "resources/earth")
    ]);
    fs.copyFileSync(
        path.join(source, "earth-theme.json"),
        path.join(destination, "resources/earth-theme.json")
    );
    const html =
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Interactive Earth</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:black}#mapCanvas{width:100%;height:100%;position:absolute;inset:0}#copyrightNotice{display:none}</style><script defer src="rendering_globe-atmosphere_bundle.js"></script></head><body><canvas id="mapCanvas"></canvas><div id="app"></div><div id="copyrightNotice"></div></body></html>\n';
    const browser = stats.stats.find(s => s.compilation.name === "browser").compilation;
    const interactive = browser.entrypoints
        .get("rendering_globe-atmosphere_bundle")
        .getFiles()
        .find(name => /^rendering_globe-atmosphere_bundle\.[a-f0-9]{12}\.js$/.test(name));
    if (!interactive) throw Error("Missing hashed interactive entry");
    // Keep the previous public URL for older HTML and external consumers. It
    // remains revalidated; only the content-addressed URL is immutable.
    fs.copyFileSync(
        path.join(destination, interactive),
        path.join(destination, "rendering_globe-atmosphere_bundle.js")
    );
    const background = browser.entrypoints
        .get("earth-background.bundle")
        .getFiles()
        .find(name => /^earth-background\.bundle\.[a-f0-9]{12}\.js$/.test(name));
    if (!background) throw Error("Missing hashed background entry");
    fs.copyFileSync(
        path.join(destination, background),
        path.join(destination, "earth-background.bundle.js")
    );
    const workers = [
        ["earth-worker", "earth-decoder"],
        ["earth-horizon", "earth-horizon"],
        ["earth-noise", "earth-noise"],
        ["earth-bc7", "earth-bc7"],
        ["earth-lidar", "earth-lidar"],
        ["earth-canopy", "earth-canopy"],
        ["earth-weather", "earth-weather"],
        ["earth-road-worker", "earth-road-worker"]
    ].map(([compilationName, workerName]) => {
        const compilation = stats.stats.find(s => s.compilation.name === compilationName)?.compilation;
        const name = compilation?.getAssets().map(asset => asset.name).find(file =>
            new RegExp(`^${workerName}\\.[a-f0-9]{12}\\.js$`).test(file)
        );
        if (!name) throw Error(`Missing hashed worker ${workerName}`);
        fs.copyFileSync(path.join(destination, name), path.join(destination, `${workerName}.bundle.js`));
        return { workerName, name };
    });
    const workerMeta = workers.map(({workerName, name}) =>
        `<meta name="earth-worker-${workerName}" content="${name}">`
    ).join("");
    // Retain prior lazy chunks when a page crosses a deployment boundary.
    const versionedMeta = browser.getAssets()
        .map(asset => asset.name)
        .filter(name => /^(?:[0-9]+|earth-[a-z0-9-]+|earth-background\.bundle|rendering_globe-atmosphere_bundle)\.[a-f0-9]{12}\.js$/.test(name))
        .map(name => `<meta name="earth-versioned-asset" content="${name}">`)
        .join("");
    const sharedFiles = new Set(stats.stats.flatMap(s => s.compilation.getAssets().map(asset => asset.name)));
    for (const name of fs.readdirSync(destination)) {
        if (
            /^(?:[0-9]+|earth-[a-z0-9-]+|earth-background\.bundle|rendering_globe-atmosphere_bundle)\.[a-f0-9]{12}\.js(?:\.map|\.LICENSE\.txt)?$/.test(name) &&
            !sharedFiles.has(name)
        )
            fs.unlinkSync(path.join(destination, name));
    }
    for (const [entry, filename, title] of [
        [
            "rendering_globe-atmosphere_bundle",
            "rendering_globe-atmosphere.html",
            "Interactive Earth"
        ],
        ["earth-background.bundle", "earth-background.html", "Earth background"]
    ]) {
        const scripts = browser.entrypoints
            .get(entry)
            .getFiles()
            .filter(name => name.endsWith(".js"))
            .map(name => `<script defer src="${name}"></script>`)
            .join("");
        fs.writeFileSync(
            path.join(destination, filename),
            html
                .replace("<title>", workerMeta + versionedMeta + "<title>")
                .replace(
                    '<script defer src="rendering_globe-atmosphere_bundle.js"></script>',
                    scripts
                )
                .replace("Interactive Earth", title)
        );
    }
    const licenses = ["3d-tiles-renderer", "@mapbox/vector-tile", "@mapbox/point-geometry", "pbf", "earcut"]
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
    fs.writeFileSync(path.join(destination, "earth-road-worker.LICENSE.txt"), licenses);
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
        "scripts/build-bright-stars.py",
        "scripts/build-forest-types.py",
        "scripts/build-lidar-index.py",
        "scripts/build-ocean-relief.py",
        "scripts/build-earth-relief.py",
        "scripts/build-page-encoders.cjs",
        "scripts/build-roof-shapes.py",
        "scripts/build-tree-crowns.py",
        "scripts/encode-bc7.c",
        "scripts/build-earth-environment.cjs",
        "scripts/build-atmosphere-lut.cjs",
        "scripts/multiple-scattering.cjs",
        "@xyzmaps/harp-examples/src/earth/atmosphere-lut.js",
        "@xyzmaps/harp-examples/src/earth/cloud-noise.js",
        "@xyzmaps/harp-examples/tsconfig.earth.json",
        "@xyzmaps/harp-examples/src/earth/earth-theme.json"
    ])
        inputs[file] = sha(fs.readFileSync(path.join(root, file)));
    const walk = dir =>
        fs
            .readdirSync(dir, { withFileTypes: true })
            .flatMap(e =>
                e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
            );
    for (const file of walk(path.join(source, "resources")))
        inputs[path.relative(root, file)] = sha(fs.readFileSync(file));
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
