#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2,<3", "pillow>=11,<13"]
# ///
"""Build the foreground star catalogue and the WebGL-only fallback texture."""
import argparse
import base64
import math
from pathlib import Path
import struct
from urllib.parse import urlencode
from urllib.request import urlopen
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image

QUERY = "select ra,dec,vmag,bv_color from bsc5p where vmag < 5.8 and ra is not null and dec is not null order by vmag"
TAP = "https://heasarc.gsfc.nasa.gov/xamin/vo/tap/sync"
DESTINATION = Path(__file__).resolve().parents[1] / "@xyzmaps/harp-examples/src/earth/resources"


def build(votable, destination):
    tree = ET.fromstring(votable)
    fields = [(f.get("name"), f.get("datatype")) for f in tree.findall(".//{*}FIELD")]
    if fields != [("ra", "double"), ("dec", "double"), ("vmag", "float"), ("bv_color", "float")]:
        raise ValueError("Unexpected HEASARC schema")
    stream = tree.find(".//{*}BINARY/{*}STREAM")
    if stream is None or stream.get("encoding") != "base64":
        raise ValueError("Expected a binary VOTable")
    width, height = 2048, 1024
    atlas = np.zeros((height, width, 3), np.float32)
    records = bytearray()
    for ra, dec, magnitude, bv in struct.iter_unpack(">ddff", base64.b64decode(stream.text)):
        if not all(map(math.isfinite, (ra, dec, magnitude))):
            continue
        column = round(((ra / 360 + .5) % 1) * 65535)
        row = round((dec / 180 + .5) * 65535)
        u, v = column / 65535, row / 65535
        # B-V photometry sets the visible tint. Compress the photometric
        # range so faint catalogue stars remain visible on a typical display.
        t = np.clip(((bv if math.isfinite(bv) else .6) + .25) / 2, 0, 1)
        color = [.72 + .28 * min(1, 2*t), .84 + .16 * (1-abs(2*t-1)), 1-.43*max(0,(t-.35)/.65)]
        brightness = np.clip(10 ** (-.15 * (magnitude + .5)), 0, 1)
        rgba = [round(value * 255) for value in (*color, brightness)]
        records.extend(struct.pack("<HHBBBB", column, row, *rgba))
        brightness = rgba[3] / 255
        color = np.asarray(rgba[:3]) / 255
        x, y = u * width, v * height
        sigma = .35 + .48 * math.sqrt(brightness)
        scale = max(.045, math.cos((v-.5)*math.pi))
        for j in range(max(0, math.floor(y-3*sigma)), min(height, math.ceil(y+3*sigma))):
            for i in range(math.floor(x-3*sigma/scale), math.ceil(x+3*sigma/scale)):
                radius2 = (((i+.5-x)*scale)**2 + (j+.5-y)**2) / (sigma*sigma)
                if radius2 <= 9:
                    atlas[height-1-j, i % width] += color * brightness * math.exp(-.5*radius2)
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "bright-stars.bin").write_bytes(records)
    pixels = np.rint(255 * np.clip(atlas, 0, 1)).astype(np.uint8)
    Image.fromarray(pixels).save(destination / "bright-stars.webp", lossless=True, method=6)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--votable", type=Path, help="Use a previously downloaded HEASARC VOTable")
    parser.add_argument("--output", type=Path, default=DESTINATION)
    args = parser.parse_args()
    if args.votable:
        data = args.votable.read_bytes()
    else:
        params = urlencode({"REQUEST":"doQuery","LANG":"ADQL","FORMAT":"votable","QUERY":QUERY})
        with urlopen(TAP + "?" + params, timeout=60) as response:
            data = response.read()
    build(data, args.output)
