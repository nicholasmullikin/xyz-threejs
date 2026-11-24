# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb>=2,<3", "pmtiles==3.7.0"]
# ///
"""Build a range-readable global catalog of mapped street lights from Overture."""

import argparse
import concurrent.futures
import gzip
import itertools
import json
import math
import os
from pathlib import Path
import struct
from urllib.request import urlopen
from xml.etree import ElementTree
import duckdb
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write

ZOOM = 13
GRID = 2**ZOOM
RELEASE = "2026-11-18.0"
SERVER = "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com"


def extract(release, cache):
    prefix = f"release/{release}/theme=base/type=infrastructure/"
    listing = ElementTree.fromstring(
        urlopen(f"{SERVER}/?list-type=2&prefix={prefix}").read()
    )
    if listing.findtext("{*}IsTruncated") == "true":
        raise ValueError("Infrastructure listing exceeds one page")
    keys = [n.text for n in listing.findall(".//{*}Key") if n.text.endswith(".parquet")]
    if not keys:
        raise ValueError("Empty Overture release")
    cache.mkdir(parents=True, exist_ok=True)

    def fetch(key):
        target = cache / Path(key).name
        if target.exists():
            return target
        temp = target.with_suffix(".partial")
        con = duckdb.connect(config={"threads": "4", "memory_limit": "600MB"})
        try:
            con.execute("load httpfs")
            # Float bbox extrema enclose the original point. Their midpoint
            # locates a lamp to ~1 m, below the width of the ground light pool.
            con.execute(
                """copy (select (bbox.xmin::double+bbox.xmax)*.5 lon,
                    (bbox.ymin::double+bbox.ymax)*.5 lat
                    from read_parquet(?) where class='street_lamp' and
                    abs(bbox.xmax-bbox.xmin)<.0001 and abs(bbox.ymax-bbox.ymin)<.0001)
                    to ? (format parquet,compression zstd)""",
                [f"{SERVER}/{key}", str(temp)],
            )
            os.replace(temp, target)
            print("Read", target.name, flush=True)
            return target
        finally:
            con.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        return list(pool.map(fetch, keys))


def build(release, cache, output):
    paths = extract(release, cache / release)
    output.parent.mkdir(exist_ok=True, parents=True)
    con = duckdb.connect(config={"threads": "4", "memory_limit": "1GB"})
    total = tiles = 0
    try:
        query = con.execute(
            f"""with projected as (
          select cast(floor((lon+180)/360*{GRID * 65536}) as bigint) gx,
          cast(floor((1-asinh(tan(radians(lat)))/pi())/2*{GRID * 65536}) as bigint) gy
          from read_parquet(?) where lon>=-180 and lon<180 and abs(lat)<85.0511287)
          select gx>>16 x,gy>>16 y,gx&65535 u,gy&65535 v from projected group by all order by y,x,v,u""",
            [[str(p) for p in paths]],
        )

        def rows():
            while batch := query.fetchmany(20000):
                yield from batch

        temp = output.with_suffix(".partial")
        with write(temp) as archive:
            for (x, y), group in itertools.groupby(rows(), lambda r: r[:2]):
                buf = bytearray()
                for _, _, u, v in group:
                    buf.extend(struct.pack("<HH", u, v))
                total += len(buf) // 4
                tiles += 1
                archive.write_tile(
                    zxy_to_tileid(ZOOM, x, y),
                    gzip.compress(buf, compresslevel=5, mtime=0),
                )
            if total == 0:
                raise ValueError("Empty street lamp catalog")
            archive.finalize(
                {"tile_compression": Compression.GZIP, "tile_type": TileType.UNKNOWN},
                {
                    "name": "Mapped street lights",
                    "attribution": "© OpenStreetMap contributors · ODbL 1.0 · Overture Maps Foundation",
                    "source": f"https://stac.overturemaps.org/{release}/base/infrastructure/collection.json",
                    "release": release,
                    "features": total,
                    "format": "ELS1",
                },
            )
        os.replace(temp, output)
        print(
            f"{total:,} mapped lights in {tiles:,} records, {output.stat().st_size:,} bytes",
            flush=True,
        )
    finally:
        con.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("output", type=Path)
    p.add_argument("--cache", type=Path, required=True)
    p.add_argument("--release", default=RELEASE)
    a = p.parse_args()
    build(a.release, a.cache, a.output)
