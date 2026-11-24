"""Bake the synchronous globe texture from the same NASA Blue Marble as the full surface.

Usage: python3 scripts/build-earth-placeholder.py /path/to/site/static/img/worldColour.5400x2700.jpg
Requires Pillow. The generated asset is imported into both Earth bundles.
"""

import argparse
import json
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    width, height = 128, 64
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    image = Image.open(args.source).convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
    image = image.quantize(colors=len(alphabet), method=Image.Quantize.MEDIANCUT)
    # DataTexture has its origin at the bottom left, unlike the source JPEG.
    image = image.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    indices = image.tobytes()
    rows = [
        "".join(alphabet[index] for index in indices[offset:offset + width])
        for offset in range(0, len(indices), width)
    ]
    asset = {
        "palette": bytes(image.getpalette()[:3 * len(alphabet)]).hex(),
        "rows": rows,
    }
    output = Path(__file__).resolve().parents[1] / "@xyzmaps/harp-examples/src/earth/surface-preview.json"
    output.write_text(json.dumps(asset, indent=2) + "\n")


if __name__ == "__main__":
    main()
