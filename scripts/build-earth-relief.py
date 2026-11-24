#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2,<3", "pillow>=11,<13", "rasterio>=1.4,<2", "scipy>=1.13,<2"]
# ///
"""Build same-origin emergency terrain from NOAA ETOPO 2022 60 arc-second surface data.

Input: https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/
The renderer uses Web Mercator to ±85.05°. Heights are approximate meters above the
EGM2008 geoid. A one-sample gutter permits bilinear sampling across regional boundaries.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from rasterio.windows import Window
from scipy.ndimage import binary_propagation, maximum_filter, minimum_filter


def ocean_mask(source):
    ref = source.read(1, out_shape=(2048, 4096), resampling=Resampling.bilinear)
    below = ref < 0
    seed = np.zeros_like(below)
    seed[:, 0], seed[:, -1], seed[0] = below[:, 0], below[:, -1], below[0]
    return binary_propagation(seed, mask=below, structure=np.ones((3, 3), bool))


def write_level(source, ocean, destination, level):
    size = 1024 if level == 4 else 128
    tiles = 2 ** level
    width = tiles * size
    radius = 6378137 * np.pi
    options = dict(crs="EPSG:3857", width=width, height=width,
                   transform=from_bounds(-radius, -radius, radius, radius, width, width))
    cols = ((np.arange(width) + .5) / width * ocean.shape[1]).astype(int)
    coverage = bytearray((tiles ** 2 + 7) // 8)
    with WarpedVRT(source, **options, resampling=Resampling.average) as mean, \
            WarpedVRT(source, **options, resampling=Resampling.min) as floors, \
            WarpedVRT(source, **options, resampling=Resampling.max) as peaks:
        for y in range(tiles):
            y0, y1 = max(0, y * size - 3), min(width, (y + 1) * size + 3)
            window = Window(0, y0, width, y1 - y0)
            height = mean.read(1, window=window)
            lat = np.arctan(np.sinh(np.pi * (1 - 2 * (np.arange(y0, y1) + .5) / width)))
            rows = np.minimum(ocean.shape[0] - 1, ((.5 - lat / np.pi) * ocean.shape[0]).astype(int))
            connected = ocean[rows[:, None], cols[None, :]]
            wet = (height < 0) & connected
            height[wet] = 0
            if level == 4:
                low = floors.read(1, window=window)
                low[(low < 0) & (connected | (height >= 0))] = 0
                # A coarse cell can span a canyon floor and rim or smooth away
                # an isolated summit. Favor local floors at valleys and recover
                # part of the original source maximum on exposed ridges.
                boundary = ("nearest", "wrap")
                bottom = minimum_filter(height, size=5, mode=boundary)
                top = maximum_filter(height, size=5, mode=boundary)
                position = (height - bottom) / np.maximum(1, top - bottom)
                valley = np.clip((.68 - position) / .52, 0, 1)
                ridge = np.clip((position - .62) / .38, 0, 1)
                low = minimum_filter(low, size=3, mode=boundary)
                high = peaks.read(1, window=window)
                height = height + .83 * valley * (low - height) + .65 * ridge * (high - height)
            quantized = np.rint(255 * np.sqrt(np.clip(np.abs(height), 0, 9000) / 9000)).astype("u1")
            alpha = np.where(wet, 0, np.where(height < 0, 254, 255)).astype("u1")
            row = np.clip(np.arange(y * size - 1, (y + 1) * size + 1), 0, width - 1) - y0
            for x in range(tiles):
                col = np.arange(x * size - 1, (x + 1) * size + 1) % width
                q = quantized[row[:, None], col[None, :]]
                a = alpha[row[:, None], col[None, :]]
                path = destination / f"{level}-{x}-{y}.webp"
                if not a.any():
                    path.unlink(missing_ok=True)
                    continue
                i = y * tiles + x
                coverage[i // 8] |= 1 << (i % 8)
                image = Image.fromarray(np.dstack((q, q, q, a)))
                image.save(path, quality=77, method=4,
                           alpha_quality=100, exact=True)
    return coverage.hex()


def build(etopo, output):
    output.mkdir(parents=True, exist_ok=True)
    with rasterio.Env(GDAL_CACHEMAX=128 * 1024 ** 2), rasterio.open(etopo) as source:
        if not np.allclose(tuple(source.bounds), [-180, -90, 180, 90], atol=.02):
            raise ValueError("Expected global ETOPO surface elevation")
        ocean = ocean_mask(source)
        coverage = []
        for level in range(5):
            coverage.append(write_level(source, ocean, output, level))
        (output / "coverage.json").write_text(json.dumps(coverage) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("etopo", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build(args.etopo, args.output)
