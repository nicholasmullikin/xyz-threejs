#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["moderngl","numpy","pillow"]
# ///
import argparse, concurrent.futures, hashlib, json, math, subprocess
import moderngl as gl
import numpy as np
from PIL import Image
from pathlib import Path

parser = argparse.ArgumentParser(
    description="Bake view-dependent normals, luminance and cutout coverage from CC0 Poly Haven trees."
)
parser.add_argument(
    "--cache", type=Path, default=Path.home() / ".cache/earth-tree-models"
)
resource = Path(__file__).resolve().parents[1] / "@xyzmaps/harp-examples/src/earth"
parser.add_argument(
    "--destination", type=Path, default=resource / "resources/tree-crowns.webp"
)
parser.add_argument("--bounds", type=Path, default=resource / "canopy-bounds.json")
args = parser.parse_args()
root = args.cache
models = ("tree_small_02", "jacaranda_tree", "pine_tree_01", "fir_tree_01")
ctx = gl.create_standalone_context(backend="egl")
print("offline GL", ctx.info["GL_RENDERER"], flush=True)
vtx = """#version 330
uniform mat4 view;uniform mat4 shadow;in vec3 p;in vec3 n;in vec2 uv;out vec3 N;out vec3 obj;out vec2 tc;out vec3 sc;
void main(){gl_Position=view*vec4(p,1.);N=n;obj=p;tc=uv;sc=(shadow*vec4(p,1.)).xyz*.5+.5;}"""
frag = """#version 330
uniform sampler2D image;uniform sampler2D opacity;uniform sampler2D depths;uniform float cameraPass;uniform vec3 modelCenter,halfSize;uniform mat3 cardOrientation;in vec3 obj;in vec2 tc;in vec3 N,sc;out vec4 pixel;void main(){if(texture(opacity,tc).r<.45)discard;
float ao=0.;if(cameraPass>.5){for(int i=-1;i<=1;i++)for(int j=-1;j<=1;j++)ao+=step(sc.z-.0025,texture(depths,sc.xy+vec2(i,j)/1024.).r);}
float gain=.66+.22*ao/9.+.20*abs(normalize(N).y);
vec3 outward=(obj-modelCenter)/max(halfSize,vec3(.01));outward.y=outward.y*.8+.25;outward=normalize(outward);vec3 surface=normalize(N);if(dot(surface,outward)<0.)surface=-surface;vec3 local=cardOrientation*normalize(mix(outward,surface,.27));
float lightness=dot(texture(image,tc).rgb,vec3(.25,.6,.15))*gain;pixel=vec4(lightness,.5+.5*local.x,.5+.5*local.y,1.);}"""
prog = ctx.program(vertex_shader=vtx, fragment_shader=frag)
prog["image"] = 0
prog["opacity"] = 1
prog["depths"] = 2
ctx.enable(gl.DEPTH_TEST)


def tex(img):
    t = ctx.texture(img.size, len(img.getbands()), img.tobytes())
    t.build_mipmaps()
    t.filter = (gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR)
    return t


white = tex(Image.new("RGB", (1, 1), "white"))
white.use(2)


def filedata(url):
    return subprocess.check_output(
        [
            "curl",
            "-fsSL",
            "-A",
            "Earth offline canopy authoring / nicholasmullikin.com",
            url,
        ]
    )


def ortho(direction, center, scale):
    d = np.array(direction, float)
    d /= np.linalg.norm(d)
    r = np.cross([0, 1, 0], d)
    r /= np.linalg.norm(r)
    u = np.cross(d, r)
    rot = np.array([r, u, -d])
    m = np.eye(4)
    m[:3, :3] = rot * 2 / scale
    m[:3, 3] = -m[:3, :3] @ center
    return np.asarray(m.T, np.float32).tobytes()


def render_model(name):
    f = root / name
    api = json.loads(filedata("https://api.polyhaven.com/files/" + name))
    gltf = api["gltf"]["1k"]["gltf"]

    def acquire(item):
        rel, info = item
        target = f / rel
        if target.exists():
            with target.open("rb") as existing:
                if hashlib.file_digest(existing, "md5").hexdigest() == info["md5"]:
                    return
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(target.suffix + ".part")
        subprocess.run(
            [
                "curl",
                "-fsSL",
                "--retry",
                "3",
                "-A",
                "Earth offline tree asset preparation / nicholasmullikin.com",
                info["url"],
                "-o",
                str(tmp),
            ],
            check=True,
        )
        with tmp.open("rb") as result:
            if hashlib.file_digest(result, "md5").hexdigest() != info["md5"]:
                raise ValueError("Unexpected Poly Haven asset checksum")
        tmp.replace(target)

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(acquire, [(name + ".gltf", gltf), *gltf["include"].items()]))
    model = json.loads((f / (name + ".gltf")).read_text())
    buffers = [
        np.memmap(f / b["uri"], dtype=np.uint8, mode="r") for b in model["buffers"]
    ]

    def accessor(i):
        acc = model["accessors"][i]
        view = model["bufferViews"][acc["bufferView"]]
        offset = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        dtype = {5126: "<f4", 5125: "<u4", 5123: "<u2", 5121: "u1"}[
            acc["componentType"]
        ]
        dim = {"VEC2": 2, "VEC3": 3, "SCALAR": 1}[acc["type"]]
        return np.ndarray(
            (acc["count"], dim),
            dtype=dtype,
            buffer=buffers[view["buffer"]],
            offset=offset,
            strides=(
                view.get("byteStride", np.dtype(dtype).itemsize * dim),
                np.dtype(dtype).itemsize,
            ),
        )

    # Each glTF node is a separate author-provided tree variation. Use one per atlas row.
    node = next(n for n in model["nodes"] if "mesh" in n)
    mesh = model["meshes"][node["mesh"]]
    vb = []
    limits = []
    for part in mesh["primitives"]:
        attr = part["attributes"]
        p = accessor(attr["POSITION"])
        limits.append([p.min(0), p.max(0)])
        v = ctx.buffer(
            np.column_stack([p, accessor(attr["NORMAL"]), accessor(attr["TEXCOORD_0"])])
            .astype(np.float32)
            .tobytes()
        )
        ind = accessor(part["indices"])
        idx = ctx.buffer(ind.tobytes())
        vao = ctx.vertex_array(
            prog,
            [(v, "3f 3f 2f", "p", "n", "uv")],
            idx,
            index_element_size=ind.dtype.itemsize,
        )
        mat = model["materials"][part["material"]]
        idxTex = mat["pbrMetallicRoughness"].get("baseColorTexture", {}).get("index")
        im = (
            model["images"][model["textures"][idxTex]["source"]]
            if idxTex is not None
            else None
        )
        color = tex(Image.open(f / im["uri"]).convert("RGB")) if im else white
        alpha = white
        if mat.get("alphaMode") in ["MASK", "BLEND"] or (im and "alpha" in im["name"]):
            keys = [k for k in api if "alpha" in k.lower()]
            ident = mat["name"].lower()
            keys.sort(key=lambda k: -int(k.split("_")[0].lower() in ident))
            key = next(iter(keys), None)
            if key:
                src = api[key]["1k"]
                a = src.get("png", src.get("jpg"))
                dst = f / (key + ".png")
                acquire((key + ".png", a))
                alpha = tex(Image.open(dst).convert("L"))
        vb.append((vao, color, alpha, v, idx))
    bounds = np.asarray(limits)
    minimum = bounds[:, 0].min(0)
    maximum = bounds[:, 1].max(0)
    center = (minimum + maximum) * 0.5
    scale = (
        max(
            maximum[1] - minimum[1],
            (maximum[0] - minimum[0]) * 0.98,
            (maximum[2] - minimum[2]) * 0.98,
        )
        * 1.12
    )
    sd = ctx.depth_texture((1024, 1024))
    sd.compare_func = ""
    sd.repeat_x = sd.repeat_y = False
    shadowFB = ctx.framebuffer(depth_attachment=sd)

    def draw():
        for vao, color, a, *_ in vb:
            color.use(0)
            a.use(1)
            vao.render()

    prog["modelCenter"].value = tuple(center)
    prog["halfSize"].value = tuple((maximum - minimum) * 0.5)
    shadow = ortho([0.43, 1.0, -0.37], center, scale * 1.7)
    prog["shadow"].write(shadow)
    prog["view"].write(shadow)
    prog["cameraPass"] = 0.0
    shadowFB.use()
    shadowFB.clear(depth=1)
    draw()
    size = 384
    fb = ctx.simple_framebuffer((size, size), components=4)
    prog["cameraPass"] = 1.0
    sd.use(2)
    cards = []
    for alt in (8, 44, 78):
        el = math.radians(alt)
        for az in (19, 109):
            az = math.radians(az)
            direction = [
                math.sin(az) * math.cos(el),
                math.sin(el),
                math.cos(az) * math.cos(el),
            ]
            rot = np.frombuffer(ortho(direction, center, scale), np.float32).reshape(
                4, 4
            ).T[:3, :3] * (scale / 2)
            rot[2] *= -1
            prog["cardOrientation"].write(np.asarray(rot.T, np.float32).tobytes())
            prog["view"].write(ortho(direction, center, scale))
            fb.use()
            fb.clear(0, 0, 0, 0, depth=1)
            draw()
            im = Image.frombytes("RGBA", (size, size), fb.read(components=4)).transpose(
                Image.Transpose.FLIP_TOP_BOTTOM
            )
            cards.append(im.resize((128, 128), Image.Resampling.LANCZOS))
    out = Image.new("RGBA", (len(cards) * 128, 128))
    [out.paste(c, (i * 128, 0)) for i, c in enumerate(cards)]
    print(name, flush=True)
    for vao, c, a, v, i in vb:
        vao.release()
        v.release()
        i.release()
        if c != white:
            c.release()
        if a != white:
            a.release()
    sd.release()
    shadowFB.release()
    fb.release()
    return out


rows = [render_model(n) for n in models]
out = Image.new("RGBA", (1024, 128 * len(rows)))
for i, r in enumerate(rows):
    out.paste(r, (0, i * 128))
args.destination.parent.mkdir(parents=True, exist_ok=True)
out.save(args.destination, quality=87, method=6)
bounds = []
for row in range(4):
    for col in range(6):
        card = out.crop((128 * col, 128 * row, 128 * (col + 1), 128 * (row + 1)))
        x, y, right, bottom = (
            card.getchannel("A")
            .point(lambda alpha: 255 if alpha >= 12 else 0)
            .getbbox()
        )
        bounds.append(
            [
                max(0, (x - 3) / 128),
                max(0, 1 - (bottom + 3) / 128),
                min(1, (right + 3) / 128),
                min(1, 1 - (y - 3) / 128),
            ]
        )
args.bounds.write_text(json.dumps(bounds, separators=(",", ":")) + "\n")
