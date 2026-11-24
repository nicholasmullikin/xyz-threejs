// Some national photomesh archives predate glTF 2. Their JPEGs, floats
// and indices are already usable. Translate the static scene description,
// preserving the original binary payload and georeferenced RTC origin.
function upgradePhotoGlb(buffer) {
    const header = new DataView(buffer);
    if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 1) return buffer;
    const jsonLength = header.getUint32(12, true),
        offset = 20 + jsonLength;
    const old = JSON.parse(
        new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)).replace(/\0+$/, "")
    );
    const ids = {},
        entries = {};
    for (const key of [
        "buffers",
        "bufferViews",
        "accessors",
        "images",
        "textures",
        "materials",
        "meshes",
        "nodes",
        "scenes",
        "samplers"
    ]) {
        entries[key] = Object.entries(old[key] || {});
        ids[key] = new Map(entries[key].map(([id], i) => [id, i]));
    }
    const ref = (type, id) => {
        const index = ids[type].get(id);
        if (index === undefined) throw Error("Missing survey " + type + " reference");
        return index;
    };
    const map = (key, fn) => entries[key].map(([id, entry]) => fn(entry, id));
    if (entries.buffers.length !== 1 || header.getUint32(16, true) !== 0)
        throw Error("Unsupported legacy photomesh buffer");
    const bin = new Uint8Array(buffer, offset, old.buffers[entries.buffers[0][0]].byteLength);
    const v = {
        asset: { version: "2.0" },
        extensionsUsed: ["KHR_materials_unlit"],
        buffers: [{ byteLength: bin.length }]
    };
    if (old.extensions?.CESIUM_RTC) {
        v.extensions = { CESIUM_RTC: old.extensions.CESIUM_RTC };
        v.extensionsUsed.push("CESIUM_RTC");
    }
    v.bufferViews = map("bufferViews", b => ({
        buffer: ref("buffers", b.buffer),
        byteOffset: b.byteOffset || 0,
        byteLength: b.byteLength
    }));
    const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 },
        bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    v.accessors = map("accessors", a => {
        const { byteStride, bufferView, ...rest } = a,
            i = ref("bufferViews", bufferView);
        if (byteStride && byteStride !== widths[a.type] * bytes[a.componentType])
            v.bufferViews[i].byteStride = byteStride;
        return { ...rest, bufferView: i };
    });
    v.images = map("images", image => {
        const embedded = image.extensions.KHR_binary_glTF;
        return { bufferView: ref("bufferViews", embedded.bufferView), mimeType: embedded.mimeType };
    });
    v.samplers = map("samplers", s => s);
    v.textures = map("textures", t => ({
        source: ref("images", t.source),
        ...(t.sampler !== undefined ? { sampler: ref("samplers", t.sampler) } : {})
    }));
    v.materials = map("materials", m => {
        const color = m.values?.diffuse;
        const pbr =
            typeof color === "string"
                ? { baseColorTexture: { index: ref("textures", color) } }
                : { baseColorFactor: Array.isArray(color) ? color : [1, 1, 1, 1] };
        return {
            extensions: { KHR_materials_unlit: {} },
            pbrMetallicRoughness: { ...pbr, metallicFactor: 0, roughnessFactor: 1 }
        };
    });
    v.meshes = map("meshes", m => ({
        primitives: m.primitives.map(p => ({
            mode: p.mode ?? 4,
            indices: ref("accessors", p.indices),
            material: ref("materials", p.material),
            attributes: Object.fromEntries(
                Object.entries(p.attributes)
                    .filter(([sem]) =>
                        ["POSITION", "NORMAL", "TEXCOORD_0", "COLOR_0"].includes(sem)
                    )
                    .map(([k, id]) => [k, ref("accessors", id)])
            )
        }))
    }));
    v.nodes = map("nodes", node => {
        if (node.meshes?.length > 1) throw Error("Unsupported multi-mesh legacy survey node");
        const result = {};
        for (const k of ["name", "matrix", "rotation", "translation", "scale"])
            if (node[k] !== undefined) result[k] = node[k];
        if (node.children?.length) result.children = node.children.map(id => ref("nodes", id));
        if (node.meshes?.length) result.mesh = ref("meshes", node.meshes[0]);
        return result;
    });
    v.scenes = map("scenes", s => ({ nodes: s.nodes.map(id => ref("nodes", id)) }));
    v.scene = ref("scenes", old.scene);
    const json = new TextEncoder().encode(JSON.stringify(v)),
        aligned = n => Math.ceil(n / 4) * 4;
    const jl = aligned(json.length),
        bl = aligned(bin.length),
        data = new Uint8Array(28 + jl + bl),
        out = new DataView(data.buffer);
    for (const [i, value] of [
        [0, 0x46546c67],
        [4, 2],
        [8, data.length],
        [12, jl],
        [16, 0x4e4f534a],
        [20 + jl, bl],
        [24 + jl, 0x004e4942]
    ])
        out.setUint32(i, value, true);
    data.fill(32, 20, 20 + jl);
    data.set(json, 20);
    data.set(bin, 28 + jl);
    return data.buffer;
}
module.exports = { upgradePhotoGlb };
