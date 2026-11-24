#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy","scipy","pillow"]
# ///
import argparse
from pathlib import Path
import numpy as np, subprocess as sp, concurrent.futures, io
from scipy.ndimage import gaussian_filter
from PIL import Image

parser = argparse.ArgumentParser(
    description="Estimate regional needleleaf fractions from NASA MODIS IGBP forest classes."
)
parser.add_argument(
    "--cache", type=Path, default=Path.home() / ".cache/earth-igbp-2020"
)
parser.add_argument(
    "--destination",
    type=Path,
    default=Path(__file__).resolve().parents[1]
    / "@xyzmaps/harp-examples/src/earth/resources/forest-type.png",
)
args = parser.parse_args()
root = args.cache
root.mkdir(parents=True, exist_ok=True)
size = 512


def read(i):
    x, y = i % 10, i // 10
    p = root / f"{y}-{x}.png"
    if not p.exists():
        url = f"https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual/default/2020-01-01/500m/3/{y}/{x}.png"
        data = sp.check_output(["curl", "-fsSL", "--retry", "3", url])
        p.write_bytes(data)
    return (x, y, np.asarray(Image.open(p).convert("RGBA").convert("RGB")))


colors = [
    (33, 138, 33),
    (49, 204, 49),
    (152, 204, 49),
    (150, 250, 150),
    (141, 186, 141),
]
arr = np.zeros((2560, 5120), np.uint8)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for x, y, a in pool.map(read, range(50)):
        t = arr[y * size : (y + 1) * size, x * size : (x + 1) * size]
        for c, rgb in enumerate(colors, 1):
            t[(a == rgb).all(2)] = c


def shrink(mask):
    return (
        np.asarray(
            Image.fromarray((mask * 255).astype(np.uint8)).resize(
                (1440, 720), Image.Resampling.BOX
            ),
            dtype=np.float32,
        )
        / 255.0
    )


forest = shrink(arr > 0)
needles = shrink((arr == 1).astype(float) + (arr == 3) + 0.5 * (arr == 5))
smooth = lambda a, s: gaussian_filter(a, sigma=s, mode=("nearest", "wrap"))
wide = smooth(forest, 1.9)
local = smooth(forest, 0.5)
ratio = (smooth(needles, 0.5) + 0.08 * smooth(needles, 1.9) + 0.0008 * 0.15) / (
    local + 0.08 * wide + 0.0008
)
out = np.uint8(np.clip(np.rint(ratio * 15) * 17, 0, 255))
Image.fromarray(out).save(args.destination, optimize=True)
