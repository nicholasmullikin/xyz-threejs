// Rebuild the checked-in, freestanding WebAssembly cache encoders. Requires
// clang with the wasm32 target and wasm-ld (also shipped by Rust toolchains).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

function linker() {
    if (process.env.WASM_LD) return process.env.WASM_LD;
    if (spawnSync("wasm-ld", ["--version"], { stdio: "ignore" }).status === 0) return "wasm-ld";
    const lib = spawnSync("rustc", ["--print", "target-libdir"], { encoding: "utf8" });
    const fallback = path.resolve(lib.stdout?.trim() || ".", "../bin/gcc-ld/wasm-ld");
    if (fs.existsSync(fallback)) return fallback;
    throw Error("Set WASM_LD to the wasm-ld executable.");
}
const destination = path.join(__dirname, "../@xyzmaps/harp-examples/src/earth/resources");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "earth-encoder-"));
try {
    const wasmLd = linker();
    for (const codec of ["bc7", "etc2"]) {
        const object = path.join(temporary, codec + ".o");
        execFileSync(
            process.env.CLANG || "clang",
            [
                "--target=wasm32",
                "-O3",
                ...(codec === "bc7" ? ["-msimd128", "-ffast-math"] : []),
                "-ffreestanding",
                "-nostdlib",
                "-c",
                path.join(__dirname, "encode-" + codec + ".c"),
                "-o",
                object
            ],
            { stdio: "inherit" }
        );
        const extra = codec === "etc2" ? ["--export=mean_squared_error"] : [];
        execFileSync(
            wasmLd,
            [
                "--no-entry",
                "--strip-all",
                "--export=encode",
                "--export=__heap_base",
                "--initial-memory=2097152",
                ...extra,
                object,
                "-o",
                path.join(destination, "page-" + codec + ".wasm")
            ],
            { stdio: "inherit" }
        );
    }
} finally {
    fs.rmSync(temporary, { recursive: true, force: true });
}
