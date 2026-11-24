#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2,<3", "pillow>=11,<13", "rasterio>=1.4,<2", "scipy>=1.13,<2"]
# ///
"""Pack NOAA ETOPO ocean relief into the alpha channel of a Blue Marble panorama.

The global 60 arc-second surface GeoTIFF can be obtained from NOAA NCEI at
https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ .
Run once offline. The browser requests a single image when the layer is selected.
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image
import rasterio
from rasterio.enums import Resampling
from scipy import ndimage


def pack(elevation, photo, destination):
    color = Image.open(photo).convert("RGB")
    w, h = color.size
    with rasterio.open(elevation) as src:
        bounds = [src.bounds.left, src.bounds.top, src.bounds.right, src.bounds.bottom]
        if not np.allclose(bounds, [-180, 90, 180, -90], atol=0.02):
            raise ValueError("Expected the global ETOPO surface raster")
        z = src.read(1, out_shape=(h, w), resampling=Resampling.average, out_dtype="float32")
    labels, _ = ndimage.label(z < -1)
    # The Pacific and Atlantic connect through the Southern Ocean. Inland
    # depressions below mean sea level must retain their satellite color.
    ocean = labels == labels[round(h * .55), round(w * .15)]
    east = (np.roll(z, -1, axis=1) - np.roll(z, 1, axis=1)) * .5
    latitude = np.radians(90 - (np.arange(h) + .5) * 180 / h)
    east /= (40075017 / w * np.maximum(.08, np.cos(latitude)))[:, None]
    north = -np.gradient(z, axis=0) / (20003931 / h)
    # Northwest cartographic illumination. Limit extreme slope angles to
    # preserve depth tint and keep the deepest trenches readable.
    relief = np.tanh((east - north) * 6)
    depth = np.sqrt(np.clip(-z / 7000, 0, 1))
    value = np.clip(.94 - .76 * depth + .37 * relief, 0, 1)
    alpha = np.where(ocean, 28 + np.rint(value * 45) * 4, 255).astype(np.uint8)
    color.putalpha(Image.fromarray(alpha))
    color.save(destination, "WEBP", quality=84, method=6, alpha_quality=100, exact=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("etopo", type=Path)
    parser.add_argument("panorama", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    pack(args.etopo, args.panorama, args.output)
