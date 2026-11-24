# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "Pillow"]
# ///
"""Downsample NASA SVS's LROC map in linear light for the existing sky atlas."""

import base64
import hashlib
import io
import json
from pathlib import Path
from urllib.request import urlopen
import numpy as np
from PIL import Image

URL = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg"


def build(raw):
    color = np.asarray(Image.open(io.BytesIO(raw)).convert("RGB"), np.float64) / 255
    linear = np.where(color <= 0.04045, color / 12.92, ((color + 0.055) / 1.055) ** 2.4)
    gray = linear @ np.array([0.2126, 0.7152, 0.0722])
    pixels = np.asarray(
        Image.fromarray(gray.astype(np.float32)).resize((80, 44), Image.Resampling.BOX)
    )[::-1]
    reflectance = np.rint(127.5 * pixels / pixels.mean()).clip(0, 255).astype("uint8")
    return dict(
        source=URL,
        sha256=hashlib.sha256(raw).hexdigest(),
        width=80,
        height=44,
        data=base64.b64encode(reflectance).decode(),
    )


if __name__ == "__main__":
    dest = (
        Path(__file__).resolve().parents[1]
        / "@xyzmaps/harp-examples/src/earth/lunar-albedo.json"
    )
    dest.write_text(
        json.dumps(build(urlopen(URL).read()), separators=(",", ":")) + "\n"
    )
