#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2,<3", "pillow>=11,<13", "rasterio>=1.4,<2", "scipy>=1.13,<2"]
# ///
"""Build a static, public-domain USGS 3DEP terrain pack from bounded WGS84 extents."""

import argparse
import json
import math
import os
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.vrt import WarpedVRT
from scipy.ndimage import distance_transform_edt

CATALOG = "https://tnmaccess.nationalmap.gov/api/v1/products"
DATASETS = ["Digital Elevation Model (DEM) 1 meter", "Seamless 1-m DEM (S1M)"]
WORLD = 2 * math.pi * 6378137
BASE, REGION, NATIVE, PIXELS = 15, 8, 17, 256
EDGE_DISTANCE = (
    192  # Native pixels of distance to surveyed coverage or a pack boundary.
)


def world_x(lon):
    return (lon + 180) / 360


def world_y(lat):
    return (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2


def world_bounds(bbox):
    west, south, east, north = bbox
    return world_x(west), world_y(north), world_x(east), world_y(south)


def intersects(a, b):
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def requested_tiles(boxes, cap):
    tiles = set()
    for z in (16, 17):
        n = 2**z
        for box in boxes:
            x0, y0, x1, y1 = world_bounds(box)
            cols = range(math.floor(x0 * n), math.ceil(x1 * n))
            rows = range(math.floor(y0 * n), math.ceil(y1 * n))
            if len(cols) * len(rows) > cap:
                raise ValueError(f"Region exceeds the {cap}-tile cap.")
            tiles.update((z, x, y) for y in rows for x in cols)
            if len(tiles) > cap:
                raise ValueError(f"Combined regions exceed the {cap}-tile cap.")
    return tiles


def catalog_products(boxes):
    products = {}
    for box in boxes:
        offset = 0
        while True:
            query = urlencode(
                {
                    "datasets": ",".join(DATASETS),
                    "bbox": ",".join(map(str, box)),
                    "max": 100,
                    "offset": offset,
                    "outputFormat": "JSON",
                }
            )
            for attempt in range(3):
                try:
                    req = Request(
                        f"{CATALOG}?{query}",
                        headers={"User-Agent": "harp-earth-terrain-pack/1"},
                    )
                    with urlopen(req, timeout=45) as response:
                        page = json.load(response)
                    if page.get("errors"):
                        raise RuntimeError(f"National Map catalog: {page['errors']}")
                    break
                except (OSError, ValueError, RuntimeError):
                    if attempt == 2:
                        raise
                    time.sleep(2**attempt)
            items = page["items"]
            for item in items:
                url = item["downloadURL"]
                if item["format"] != "GeoTIFF" or not url.lower().endswith(
                    (".tif", ".tiff")
                ):
                    continue
                b = item["boundingBox"]
                products[item["sourceId"]] = {
                    "id": item["sourceId"],
                    "title": item["title"],
                    "url": url,
                    "published": item["publicationDate"],
                    "bounds": [b["minX"], b["minY"], b["maxX"], b["maxY"]],
                }
            offset += len(items)
            if offset >= page["total"] or not items:
                break
    # The same ordering on either side of a pack tile boundary also handles
    # duplicate regional products in adjacent UTM zones deterministically.
    return sorted(
        products.values(), key=lambda p: (p["published"], p["id"]), reverse=True
    )


def read_block(x, y, boxes, products):
    factor = 2 ** (NATIVE - BASE)
    size = factor * PIXELS
    halo = EDGE_DISTANCE + 2
    span = size + 2 * halo
    n = 2**NATIVE * PIXELS
    start_x, start_y = x * size - halo, y * size - halo
    u = (start_x + np.arange(span) + 0.5) / n
    v = (start_y + np.arange(span) + 0.5) / n
    requested = np.zeros((span, span), dtype=bool)
    for x0, y0, x1, y1 in boxes:
        requested |= ((v >= y0) & (v < y1))[:, None] & ((u >= x0) & (u < x1))[None, :]
    bounds = (start_x / n, start_y / n, (start_x + span) / n, (start_y + span) / n)
    transform = from_bounds(
        (bounds[0] - 0.5) * WORLD,
        (0.5 - bounds[3]) * WORLD,
        (bounds[2] - 0.5) * WORLD,
        (0.5 - bounds[1]) * WORLD,
        span,
        span,
    )
    height = np.full((span, span), np.nan, dtype="float32")
    used = []
    for product in products:
        if not intersects(bounds, world_bounds(product["bounds"])):
            continue
        with rasterio.open(product["url"]) as src:
            unit = (src.units[0] or "m").lower()
            if unit not in ("m", "meter", "meters", "metre", "metres"):
                raise ValueError(
                    f"Unexpected USGS vertical unit {unit} in {product['url']}"
                )
            product["crs"] = str(src.crs)
            with WarpedVRT(
                src,
                crs="EPSG:3857",
                transform=transform,
                width=span,
                height=span,
                resampling=Resampling.bilinear,
                nodata=-999999,
            ) as warped:
                samples = warped.read(1, masked=True)
                take = requested & ~np.isfinite(height) & ~np.ma.getmaskarray(samples)
                take &= (
                    np.isfinite(samples.data)
                    & (samples.data > -10000)
                    & (samples.data < 10000)
                )
                if take.any():
                    height[take] = samples.data[take]
                    used.append(product["id"])
                if np.isfinite(height[requested]).all():
                    break
    valid = np.isfinite(height)
    # The halo supplies samples across adjacent blocks, so feathering appears
    # only at actual survey/pack boundaries. Explicitly exclude source nodata.
    dist = distance_transform_edt(np.pad(valid, 1))[1:-1, 1:-1]
    alpha = np.clip((dist - 1) / EDGE_DISTANCE, 0, 1).astype("float32")
    center = np.s_[halo : halo + size, halo : halo + size]
    return np.nan_to_num(height[center]), alpha[center], used


def save_tile(path, height, alpha):
    weight = np.rint(alpha * 255).astype("uint8")
    if not weight.any():
        return 0
    encoded = np.rint((height.astype("float64") + 10000) * 10).astype("uint32")
    encoded[weight == 0] = 100000
    rgb = [encoded >> 16, encoded >> 8, encoded]
    full = np.all(weight == 255)
    data = np.stack(rgb if full else [*rgb, weight], axis=-1).astype("uint8")
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(data).save(path, compress_level=6)
    return 1 if full else 2


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n")


def build(folder, boxes, tiles, products):
    bounds = [world_bounds(box) for box in boxes]
    blocks = sorted({(x // 4, y // 4) for z, x, y in tiles if z == NATIVE})
    regions = defaultdict(list)
    created = size = 0
    used = set()
    with rasterio.Env(
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        GDAL_HTTP_TIMEOUT="40",
        GDAL_HTTP_MAX_RETRY="2",
        CPL_VSIL_CURL_CACHE_SIZE=32 * 1024 * 1024,
        GDAL_CACHEMAX=64 * 1024 * 1024,
    ):
        for x, y in blocks:
            height, alpha, sources = read_block(x, y, bounds, products)
            if not np.any(alpha):
                continue
            used.update(sources)
            region_x, region_y = x >> 7, y >> 7
            row = [(y % 128) * 128 + x % 128]
            for z, step in ((16, 2), (17, 1)):
                if step == 1:
                    h, a = height, alpha
                else:

                    def mean(array):
                        return array.reshape(
                            array.shape[0] // 2, 2, array.shape[1] // 2, 2
                        ).mean(axis=(1, 3))

                    a = mean(alpha)
                    h = np.divide(
                        mean(alpha * height), a, out=np.zeros_like(a), where=a > 0
                    )
                side = 2 ** (z - BASE)
                valid = masked = 0
                for dy in range(side):
                    for dx in range(side):
                        tx, ty = x * side + dx, y * side + dy
                        if (z, tx, ty) not in tiles:
                            continue
                        section = np.s_[
                            dy * PIXELS : (dy + 1) * PIXELS,
                            dx * PIXELS : (dx + 1) * PIXELS,
                        ]
                        path = folder / "tiles" / str(z) / str(tx) / f"{ty}.png"
                        kind = save_tile(path, h[section], a[section])
                        if kind:
                            bit = 1 << (dy * side + dx)
                            valid |= bit
                            if kind == 2:
                                masked |= bit
                            created += 1
                            size += path.stat().st_size
                row += [valid, masked]
            if row[1] or row[3]:
                regions[f"{region_x}/{region_y}"].append(row)
    for key, rows in regions.items():
        write_json(folder / "regions" / f"{key}.json", sorted(rows))
    write_json(
        folder / "sources.json",
        {
            "datasets": DATASETS,
            "provider": "USGS 3D Elevation Program",
            "catalog": CATALOG,
            "bounds": boxes,
            "sources": [p for p in products if p["id"] in used],
        },
    )
    write_json(
        folder / "manifest.json",
        {
            "format": "harp-3dep-v1",
            "edgeDistancePixels": EDGE_DISTANCE,
            "regions": sorted(regions),
        },
    )
    return created, size


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    area = parser.add_mutually_exclusive_group(required=True)
    area.add_argument(
        "--bbox",
        nargs=4,
        type=float,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        action="append",
        help="WGS84 degrees; repeat for disjoint areas",
    )
    area.add_argument(
        "--sources-json",
        type=Path,
        help="Replay the bounds and exact source URLs saved by a previous build",
    )
    parser.add_argument(
        "--output", type=Path, required=True, help="New static pack directory"
    )
    parser.add_argument(
        "--max-tiles",
        type=int,
        default=256,
        help="Upper bound on combined zoom 16 and 17 tiles (default 256)",
    )
    args = parser.parse_args()
    snapshot = json.loads(args.sources_json.read_text()) if args.sources_json else None
    boxes = snapshot["bounds"] if snapshot is not None else args.bbox
    for w, s, e, n in boxes:
        if not (-180 <= w < e <= 180 and -85 < s < n < 85):
            parser.error(
                "Use west < east and south < north within Web Mercator coverage."
            )
    if args.output.exists():
        parser.error("Choose a new output directory for this version of the pack.")
    tiles = requested_tiles(boxes, args.max_tiles)
    started = time.monotonic()
    products = snapshot["sources"] if snapshot is not None else catalog_products(boxes)
    print(
        f"Selected {len(products)} 1 m products; at most {len(tiles)} output tiles.",
        flush=True,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.output.parent) as tmp:
        folder = Path(tmp) / "pack"
        folder.mkdir()
        created, size = build(folder, boxes, tiles, products)
        os.rename(folder, args.output)
    print(
        f"{created} tiles, {size / 1e6:.2f} MB, {time.monotonic() - started:.1f} seconds. {args.output / 'manifest.json'}"
    )


if __name__ == "__main__":
    main()
