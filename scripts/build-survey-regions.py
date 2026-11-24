# /// script
# requires-python = ">=3.10"
# dependencies = ["shapely>=2,<3", "Pillow>=10"]
# ///
"""Refresh optional model coverage and the geoid strips needed by those models."""

import argparse
import json
import math
import urllib.request
from pathlib import Path

from PIL import Image
from shapely.geometry import shape
from shapely.geometry.polygon import orient

OUT = Path(__file__).resolve().parents[1] / "@xyzmaps/harp-examples/src/earth"
COUNTRIES = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson"
JAPAN = "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-lod2-texture-latest/tileset.json"


def read(url):
    with urllib.request.urlopen(url, timeout=45) as r:
        return json.load(r)


def write(name, value):
    (OUT / name).write_text(json.dumps(value, separators=(",", ":")) + "\n")


def main(grid):
    selected = {"CHE": "swiss", "NLD": "3dbag", "LUX": "luxembourg"}
    coverage = {}
    for feature in read(COUNTRIES)["features"]:
        key = selected.get(feature["properties"].get("ADM0_A3"))
        if key is None:
            continue
        poly = (
            shape(feature["geometry"])
            .buffer(0.012)
            .simplify(0.007, preserve_topology=True)
        )
        parts = getattr(poly, "geoms", [poly])
        coverage[key] = [
            [round(val * 1000) for point in orient(p).exterior.coords for val in point]
            for p in parts
            if p.centroid.y > 45
        ]
    children = read(JAPAN)["root"]["children"]
    coverage["plateau"] = [
        [
            math.floor(math.degrees(v) * 1000) - 5
            if i < 2
            else math.ceil(math.degrees(v) * 1000) + 5
            for i, v in enumerate(child["boundingVolume"]["region"][:4])
        ]
        for child in children
    ]
    write("survey-coverage.json", coverage)
    # EGM96 undulations from the PROJ project's point-sampled NGA 15-minute
    # GeoTIFF (https://cdn.proj.org/us_nga_egm96_15.tif), in decimetres.
    with Image.open(grid) as im:
        assert im.size == (1440, 721) and im.tag_v2[33922][3:5] == (-180.0, 90.0)
        cells = []
        for west, south, east, north in [
            (3, 45.5, 10.75, 53.75),
            (127.5, 26, 142.5, 43.5),
        ]:
            nx, ny = round((east - west) * 4) + 1, round((north - south) * 4) + 1
            samples = [
                round(
                    10
                    * im.getpixel(
                        (round((west + 180) * 4) + x, round((90 - south) * 4) - y)
                    )
                )
                for y in range(ny)
                for x in range(nx)
            ]
            cells.append(
                dict(west=west, south=south, step=0.25, nx=nx, samples=samples)
            )
    write("survey-geoid.json", cells)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--geoid", type=Path, default=Path("/usr/share/proj/us_nga_egm96_15.tif")
    )
    main(parser.parse_args().geoid)
