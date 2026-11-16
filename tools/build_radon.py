# /// script
# requires-python = ">=3.10"
# dependencies = ["geopandas>=1.0", "pyogrio>=0.9", "rasterio>=1.3", "numpy>=1.24"]
# ///
"""Convert the BGS/UKHSA Indicative Atlas of Radon (GB) into a compact grid
that the web page can load: docs/radon-gb.bin.

Run once (and again if BGS publish a new version):

    uv run tools/build_radon.py            (finds the atlas in data/radon/)

Output format (little-endian):
    bytes 0-3   b"RDN1"
    bytes 4-5   uint16 width  (number of 1 km columns)
    bytes 6-7   uint16 height (number of 1 km rows)
    bytes 8-9   uint16 x0 in km (BNG easting of column 0)
    bytes 10-11 uint16 y0 in km (BNG northing of row 0)
    bytes 12-15 reserved
    then width*height 4-bit cells, two per byte (even cell in the low nibble),
    row-major starting at the south-west corner. 0 = no data, 1-6 = radon class.

Each 1 km square gets the highest class found anywhere inside it, the same rule
the atlas itself uses.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import geopandas as gpd
import numpy as np
from rasterio import features
from rasterio.transform import from_origin

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "radon-gb.bin"
CANDIDATES = ("CLASS_MAX", "RADON_CLASS", "CLASS", "Class_Max", "class_max")

# Extent of Great Britain in British National Grid, in km.
X0_KM, Y0_KM, W_KM, H_KM = 0, 0, 700, 1250
SUB = 4  # rasterise at 250 m, then take the max over each 1 km square


def pick_column(gdf: gpd.GeoDataFrame, override: str | None) -> str:
    cols = [c for c in gdf.columns if c != "geometry"]
    if override:
        if override not in cols:
            sys.exit(f"Column {override!r} not found. Columns: {cols}")
        return override
    for c in CANDIDATES:
        if c in cols:
            return c
    fuzzy = [c for c in cols if "class" in c.lower()]
    if len(fuzzy) == 1:
        return fuzzy[0]
    sys.exit(f"Can't tell which column is the radon class. Columns: {cols}\n"
             "Re-run with --class-column NAME.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("atlas", nargs="?",
                    help="Atlas .gpkg or .shp (default: the one in data/radon/)")
    ap.add_argument("--layer")
    ap.add_argument("--class-column")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    atlas = args.atlas
    if not atlas:
        data_dir = ROOT / "data" / "radon"
        found = sorted(data_dir.rglob("*.gpkg")) or sorted(data_dir.rglob("*.shp"))
        if not found:
            sys.exit(f"No .gpkg or .shp found in {data_dir}. Download the atlas and put it there.")
        if len(found) > 1:
            sys.exit("More than one atlas file found - pass the one to use:\n  "
                     + "\n  ".join(str(f) for f in found))
        atlas = found[0]
    elif not Path(atlas).exists():
        sys.exit(f"File not found: {atlas}")
    print(f"Reading {atlas}")

    layer = args.layer
    if layer is None:
        import pyogrio
        # GeoPackages from BGS also contain a 'layer_styles' table; skip it.
        layers = [name for name, geom in pyogrio.list_layers(atlas) if geom and name != "layer_styles"]
        layer = layers[0] if layers else None
    gdf = gpd.read_file(atlas, layer=layer)
    if gdf.crs is None:
        gdf = gdf.set_crs(27700)
    elif gdf.crs.to_epsg() != 27700:
        gdf = gdf.to_crs(27700)
    col = pick_column(gdf, args.class_column)
    gdf = gdf[gdf[col].notna() & gdf.geometry.notna()].copy()
    gdf[col] = gdf[col].astype(int)
    bad = set(gdf[col].unique()) - set(range(1, 7))
    if bad:
        sys.exit(f"Unexpected values in {col!r}: {sorted(bad)} (expected 1-6). "
                 "Is this the right column? Try --class-column.")
    print(f"Read {len(gdf)} polygons, class column {col!r}")

    # Burn low classes first so higher classes win where polygons overlap.
    gdf = gdf.sort_values(col)
    res = 1000 / SUB
    transform = from_origin(X0_KM * 1000, (Y0_KM + H_KM) * 1000, res, res)
    fine = features.rasterize(
        ((geom, int(v)) for geom, v in zip(gdf.geometry, gdf[col])),
        out_shape=(H_KM * SUB, W_KM * SUB),
        transform=transform,
        fill=0,
        dtype="uint8",
    )
    # Max over each SUBxSUB block -> 1 km grid; flip so row 0 is the south edge.
    grid = fine.reshape(H_KM, SUB, W_KM, SUB).max(axis=(1, 3))[::-1]

    flat = grid.ravel()
    if flat.size % 2:
        flat = np.append(flat, 0)
    packed = (flat[0::2] | (flat[1::2] << 4)).astype(np.uint8)
    header = b"RDN1" + np.array([W_KM, H_KM, X0_KM, Y0_KM, 0, 0], dtype="<u2").tobytes()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(header + packed.tobytes())

    counts = {c: int((grid == c).sum()) for c in range(7)}
    print(f"Wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
    print("1 km squares per class:", {k: v for k, v in counts.items() if v})


if __name__ == "__main__":
    main()
