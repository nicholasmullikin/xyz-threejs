"""Partition Luxembourg ACT's CC0 2020 photomesh hierarchy.

The published pyramid is a single ~20 MB JSON document. Keep original bounding
volumes, geometric errors, renderable ancestors and model URLs; divide only the
directory into external 3D Tiles tilesets. Geometry and JPEGs stay upstream.
"""

import argparse
import json
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

SOURCE = "https://acts3.geoportail.lu/3d-data/3d-tiles/mesh3D/mesh3D_2020_v2/Cesium/pyramid/tileset.json"
ENCODE = json.JSONEncoder(separators=(",", ":"), allow_nan=False).encode


def partition(data, dest, limit=48000):
    dest.mkdir(parents=True, exist_ok=True)
    documents = 0

    def save(root, name, error):
        doc = {"asset": {"version": "1.0"}, "geometricError": error, "root": root}
        (dest / name).write_text(ENCODE(doc) + "\n")

    def visit(node):
        nonlocal documents
        children = node.pop("children", [])
        content = node.get("content")
        if content:
            content["uri"] = urljoin(SOURCE, content["uri"])
            if content.get("boundingVolume") == node["boundingVolume"]:
                del content["boundingVolume"]
        size = len(ENCODE(node))
        if not children:
            return node, size
        parts = [visit(c) for c in children]
        size += sum(n + 1 for _, n in parts)
        if size > limit:
            for i, (child, n) in sorted(enumerate(parts), key=lambda p: -p[1][1]):
                if size <= limit or n < 1500:
                    break
                # Region bounds are geodetic. The original root (and its
                # existing transform, if any) remains intact in the external file.
                if "region" not in child["boundingVolume"]:
                    raise ValueError("Expected region bounds in the ACT pyramid")
                name = f"branch-{documents}.json"
                documents += 1
                err = child["geometricError"]
                save(child, name, err)
                ref = {
                    "boundingVolume": child["boundingVolume"],
                    "refine": child.get("refine", "REPLACE"),
                    "geometricError": err,
                    "content": {"uri": name},
                }
                nr = len(ENCODE(ref))
                parts[i] = (ref, nr)
                size += nr - n
        node["children"] = [child for child, _ in parts]
        return node, size

    root, _ = visit(data["root"])
    save(root, "tileset.json", data.get("geometricError", root["geometricError"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--input", type=Path)
    args = parser.parse_args()
    with (
        args.input.open()
        if args.input
        else urllib.request.urlopen(SOURCE, timeout=60) as f
    ):
        partition(json.load(f), args.destination)
