# /// script
# requires-python = ">=3.11"
# dependencies = ["shapely>=2,<3"]
# ///
"""Partition the public USGS 3DEP EPT footprints for lazy city-scale lookup."""

import argparse
import json
import math
import re
import urllib.request
from pathlib import Path

from shapely.geometry import box, shape

URL = "https://usgs.entwine.io/boundaries/resources.geojson"


def build(features, destination):
    bins = {}
    for feature in features:
        name = feature["properties"]["name"]
        if not re.fullmatch("[A-Za-z0-9_.-]+", name):
            continue
        footprint = shape(feature["geometry"])
        if not footprint.is_valid:
            footprint = footprint.buffer(0)
        if footprint.is_empty:
            continue
        years = re.findall(r"(?:^|_)(20[012]\d)(?:_|$)", name)
        year = int(years[0]) if years else 0
        if match := re.search(r"_B(2[0-9])(?:_|$)", name):
            year = max(year, 2000 + int(match[1]))
        lat = footprint.centroid.y
        density = feature["properties"]["count"] / max(
            1, footprint.area * 111320**2 * math.cos(math.radians(lat))
        )
        w, s, e, n = footprint.bounds
        for x in range(math.floor(w / 5), math.floor(e / 5) + 1):
            for y in range(math.floor(s / 5), math.floor(n / 5) + 1):
                clipped = footprint.intersection(
                    box(5 * x, 5 * y, 5 * x + 5, 5 * y + 5)
                ).simplify(0.0003, preserve_topology=True)
                polys = (
                    [clipped]
                    if clipped.geom_type == "Polygon"
                    else list(getattr(clipped, "geoms", []))
                )
                rings = []
                for p in polys:
                    if p.geom_type != "Polygon" or p.is_empty:
                        continue
                    encoded = []
                    for ring in [p.exterior, *p.interiors]:
                        pairs = [
                            (round((lon - 5 * x) * 10000), round((lat - 5 * y) * 10000))
                            for lon, lat, *_ in ring.coords
                        ]
                        if len(set(pairs)) < 3:
                            continue
                        encoded.append([v for pair in pairs[:-1] for v in pair])
                    if encoded:
                        rings.append(encoded)
                if rings:
                    bins.setdefault(f"{x}_{y}", []).append(
                        [name, year, round(min(100, density), 1), rings]
                    )
    destination.mkdir(parents=True, exist_ok=True)
    for key, entries in bins.items():
        entries.sort(key=lambda record: (-record[1], -record[2], record[0]))
        (destination / f"{key}.json").write_text(
            json.dumps(entries, separators=(",", ":"))
        )
    (destination / "index.json").write_text(
        json.dumps({"cells": sorted(bins), "source": URL}, separators=(",", ":"))
    )
    print(f"{len(features)} survey footprints in {len(bins)} regional indexes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--input", type=Path)
    args = parser.parse_args()
    data = json.loads(
        args.input.read_bytes()
        if args.input
        else urllib.request.urlopen(URL, timeout=60).read()
    )
    build(data["features"], args.destination)
