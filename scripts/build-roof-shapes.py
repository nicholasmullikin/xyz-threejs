# /// script
# requires-python = ">=3.11"
# dependencies = ["duckdb>=1.4,<3", "pmtiles==3.7.0", "webcolors==24.11.1"]
# ///
"""Build the optional global OSM roof-tag companion to OpenMapTiles z14 buildings.

uv run scripts/build-roof-shapes.py buildings.parquet OUTPUT_DIRECTORY
Get buildings.parquet from https://layercake.openstreetmap.us/layers/buildings/.
Pass --bbox W S E N for a regional build. Footprint bounds disambiguate merged OpenMapTiles features.
"""

import argparse
import gzip
from functools import lru_cache
import re
import itertools
import json
import os
import struct
from pathlib import Path

import webcolors
import duckdb
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write

# Numeric order is part of the ERF4 tile layout. Keep in sync with roof-shapes.js.
SHAPES = (
    "gabled",
    "hipped",
    "half-hipped",
    "pyramidal",
    "skillion",
    "gambrel",
    "mansard",
    "round",
    "dome",
    "onion",
    "cone",
    "saltbox",
)
ZOOM = 12


def varint(buffer, value):
    while value >= 128:
        buffer.append((value & 127) | 128)
        value >>= 7
    buffer.append(value)


# Convert recorded paints and a few recognizable roofing materials to compact sRGB.
@lru_cache(maxsize=4096)
def roof_color(text, material):
    names = {
        "red": "aa6049",
        "brown": "89604d",
        "green": "627f68",
        "grey": "888988",
        "gray": "888988",
        "black": "474a4e",
        "white": "d5d4cb",
        "blue": "587389",
        "copper": "9c6852",
    }
    materials = {
        "roof_tiles": "a16c56",
        "clay": "a16c56",
        "slate": "626673",
        "thatch": "998663",
        "grass": "68905c",
        "asphalt": "636363",
        "concrete": "96948c",
        "tar_paper": "595956",
    }
    raw = (text or "").strip().lower()
    if re.fullmatch("#[0-9a-f]{3}", raw):
        raw = "".join(c * 2 for c in raw[1:])
    elif re.fullmatch("#[0-9a-f]{6}", raw):
        raw = raw[1:]
    else:
        named = names.get(raw)
        if not named and raw:
            try:
                named = webcolors.name_to_hex(raw).lstrip("#")
            except ValueError:
                pass
        raw = named or materials.get(material)
    if not raw:
        return None
    r, g, b = bytes.fromhex(raw)
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


# Material classes affect both paint defaults and the existing facade shader.
# Unknown or ambiguous material names retain the basemap styling.
WALLS = {
    "brick": (1, "#ae7862"),
    "plaster": (2, "#c4bcad"),
    "plastered": (2, "#c4bcad"),
    "wood": (3, "#ab8a6d"),
    "timber_framing": (3, "#93745b"),
    "stone": (4, "#a7a399"),
    "sandstone": (4, "#c0a485"),
    "concrete": (5, "#a7a7a3"),
    "cement_block": (5, "#aaa6a0"),
    "block": (5, "#aaa6a0"),
    "metal": (6, "#8b969a"),
    "steel": (6, "#89949a"),
    "metal_plates": (6, "#879297"),
    "glass": (7, "#788e9a"),
    "mud": (8, "#ac8a6b"),
    "earth": (8, "#a58465"),
}


def build(source, destination, bbox, parts=None):
    db = duckdb.connect(config={"threads": "4", "memory_limit": "2GB"})
    db.execute("create macro mx(lon) as ((lon+180.)*4096./360.)")
    db.execute(
        "create macro my(lat) as ((1.-asinh(tan(radians(greatest(-85.05,least(85.05,lat)))))/pi())*2048.)"
    )
    db.execute(
        "create temp table roof_types as select unnest(?) shape,generate_subscripts(?,1) ordinal",
        [list(SHAPES), list(SHAPES)],
    )
    condition = ""
    params = []
    inp = 'select type,id,bbox,height,"roof:shape","roof:orientation","roof:height","roof:levels",NULL::double bearing,"roof:colour" paint,"roof:material" roofing,building category,"building:part" is not null part,"building:colour" wall_paint,"building:material" wall_material from read_parquet(?)'
    params.append(source)
    if parts:
        inp += """ union all select case left(ref,1) when 'w' then 'way' else 'relation' end,
        try_cast(regexp_extract(ref,'^[wr]([0-9]+)',1) as bigint),bbox,height::varchar,
        case roof_shape when 'spherical' then 'dome' when 'half_hipped' then 'half-hipped' else roof_shape end,roof_orientation,roof_height::varchar,null::varchar,roof_direction,roof_color,roof_material,null::varchar,true,facade_color,facade_material
        from (select *,sources[1].record_id ref from read_parquet(?)
        where sources[1].dataset='OpenStreetMap' and (roof_shape is not null or roof_color is not null or roof_material is not null or facade_color is not null or facade_material is not null)) where ref~'^[wr][0-9]+(@[0-9]+)?$'"""
        params.append(parts)
    if bbox:
        condition = "and bbox.xmax >= ? and bbox.ymax >= ? and bbox.xmin <= ? and bbox.ymin <= ?"
        params.extend(bbox)
    # Include the small buffer used by the z14 footprint tiles. Bounded cross-tile
    # expansion handles buildings that straddle a z12 archive record boundary.
    sql = f"""
    with input as ({inp}), tagged as (
      select id*10+case type when 'way' then 2 else 3 end fid,
        coalesce(roof_types.ordinal,0)::int shape,
        coalesce("roof:orientation"='across',false) across,
        coalesce(try_cast(regexp_extract(height,'^[0-9]+(?:[.][0-9]+)?',0) as double)>0,false) measured,
        greatest(0,least(8000,round(10*coalesce(
          try_cast(regexp_extract("roof:height",'^([0-9]+(?:[.][0-9]+)?)\\s*(?:m)?$',1) as double),
          3*try_cast("roof:levels" as double),0))))::int rise,
        round(mx(bbox.xmin)*16384)::bigint l,round(my(bbox.ymax)*16384)::bigint t,
        round(mx(bbox.xmax)*16384)::bigint r,round(my(bbox.ymin)*16384)::bigint b,
        bearing,paint,roofing,wall_paint,wall_material,coalesce(category in ('cathedral','church','chapel','mosque','temple','synagogue','silo','storage_tank','bunker','roof'),false) as plain,part, floor(mx(bbox.xmin)-0.02)::int x0, floor(mx(bbox.xmax)+0.02)::int x1,
        floor(my(bbox.ymax)-0.02)::int y0, floor(my(bbox.ymin)+0.02)::int y1
      from input left join roof_types on roof_types.shape="roof:shape"
      where type in ('way','relation') and id>0 and (roof_types.ordinal is not null or paint is not null or roofing is not null or wall_paint is not null or wall_material is not null) {condition}
    )
    select x,y,fid,shape,across,measured,rise,l-16384*x,t-16384*y,r-16384*x,b-16384*y,bearing,paint,roofing,plain,part,wall_paint,wall_material from tagged,
      lateral range(greatest(0,x0),least(4095,x1)+1) cols(x),
      lateral range(greatest(0,y0),least(4095,y1)+1) rows(y)
    where x1-x0 between 0 and 4 and y1-y0 between 0 and 4
    order by y,x,fid,measured desc,rise desc,bearing nulls last
    """
    dst = Path(destination)
    partitioned = dst.suffix != ".pmtiles"
    if partitioned:
        sql = sql.replace("order by y,x,fid", "order by (y>>8),(x>>8),y,x,fid")
        dst.mkdir(parents=True, exist_ok=True)
    cursor = db.execute(sql, params)

    def rows():
        while batch := cursor.fetchmany(10000):
            yield from batch

    count = tiles = total = 0
    parts = []
    for region, regional in itertools.groupby(
        rows(), lambda row: (row[0] >> 8, row[1] >> 8) if partitioned else (0, 0)
    ):
        name = f"{region[0]}-{region[1]}.pmtiles"
        output = dst / name if partitioned else dst
        output.parent.mkdir(parents=True, exist_ok=True)
        temp = output.with_name(output.name + ".partial")
        with write(temp) as archive:
            for (x, y), group in itertools.groupby(regional, lambda row: row[:2]):
                buffer = bytearray(b"ERF4")
                previous = 0
                for (
                    _,
                    _,
                    fid,
                    shape,
                    across,
                    measured,
                    rise,
                    left,
                    top,
                    right,
                    bottom,
                    bearing,
                    paint,
                    roofing,
                    plain,
                    part,
                    wall_paint,
                    wall_material,
                ) in group:
                    if (
                        fid == previous
                        or min(left, top, right, bottom) < -32768
                        or max(left, top, right, bottom) > 32767
                    ):
                        continue
                    wall_class, default_paint = WALLS.get(wall_material, (0, None))
                    wall = roof_color(wall_paint, None)
                    if wall is None and default_paint:
                        wall = roof_color(default_paint, None)
                    color = roof_color(paint, roofing)
                    if not shape and wall is None and color is None:
                        continue
                    varint(buffer, fid - previous)
                    previous = fid
                    buffer.append(
                        shape
                        | (16 if across else 0)
                        | (32 if measured else 0)
                        | (64 if rise else 0)
                        | (128 if bearing is not None else 0)
                    )
                    if rise:
                        varint(buffer, rise)
                    if bearing is not None:
                        buffer.append(round((bearing % 360) * 256 / 360) % 256)
                    buffer.append(
                        (1 if color is not None else 0)
                        | (2 if plain else 0)
                        | (4 if part else 0)
                        | (8 if wall is not None else 0)
                        | (16 if wall_class else 0)
                    )
                    if color is not None:
                        buffer.extend(struct.pack("<H", color))
                    if wall is not None:
                        buffer.extend(struct.pack("<H", wall))
                    if wall_class:
                        buffer.append(wall_class)
                    buffer.extend(struct.pack("<hhhh", left, top, right, bottom))
                    count += 1
                archive.write_tile(
                    zxy_to_tileid(ZOOM, x, y),
                    gzip.compress(buffer, compresslevel=6, mtime=0),
                )
                tiles += 1
            if not archive.addressed_tiles:
                raise ValueError("No supported OSM roof shapes in this extract")
            archive.finalize(
                {"tile_compression": Compression.GZIP, "tile_type": TileType.UNKNOWN},
                {
                    "name": "OpenStreetMap roof shapes",
                    "attribution": "© OpenStreetMap contributors · ODbL 1.0 · OpenStreetMap US Layercake",
                    "source": "https://layercake.openstreetmap.us/layers/buildings/",
                    "format": "ERF4",
                },
            )
        os.replace(temp, output)
        parts.append(name)
        total += output.stat().st_size
    db.close()
    if not tiles:
        raise ValueError("No supported OSM roof shapes in this extract")
    if partitioned:
        index = {
            "format": "ERF4",
            "regions": parts,
            "attribution": "© OpenStreetMap contributors (ODbL 1.0) via OpenStreetMap US Layercake and Overture Maps Foundation.",
        }
        (dst / "index.json").write_text(json.dumps(index, separators=(",", ":")) + "\n")
    print(f"{count:,} roof tags in {tiles:,} tiles, {total:,} bytes", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument(
        "--parts",
        help="Optional Overture building_part Parquet file or glob. Only OSM features are used.",
    )
    parser.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"))
    args = parser.parse_args()
    build(args.source, args.destination, args.bbox, args.parts)
