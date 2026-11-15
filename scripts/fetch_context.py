"""OpenStreetMap buildings across the rivers from NYC, by bounding box (fast on Overpass),
for the areas seen from the harbour: Jersey City, Hoboken, Bayonne and Union City; the
Palisades towns from Weehawken to Fort Lee; Newark Bay and Elizabeth; Yonkers; western
Nassau. Buildings inside the five boroughs are dropped later (build_city.py).
Writes data/raw/osm_ctx/bbox_<name>.json.gz."""
from __future__ import annotations

import gzip
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import overpass  # noqa: E402

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "raw", "osm_ctx")
BOXES = [  # name, south, west, north, east
    ("jersey_city", 40.70, -74.10, 40.75, -74.022), ("hoboken_union", 40.75, -74.06, 40.80, -74.015),
    ("bayonne", 40.64, -74.14, 40.70, -74.06), ("jc_west", 40.70, -74.14, 40.75, -74.10),
    ("palisades", 40.80, -74.01, 40.86, -73.95), ("fort_lee_north", 40.86, -73.99, 40.95, -73.93),
    ("newark_bay", 40.64, -74.20, 40.75, -74.14), ("elizabeth", 40.58, -74.26, 40.70, -74.18),
    ("perth_amboy", 40.48, -74.27, 40.58, -74.19), ("yonkers", 40.91, -73.92, 40.96, -73.82),
    ("mount_vernon", 40.89, -73.86, 40.96, -73.74), ("nassau_west", 40.60, -73.74, 40.80, -73.68),
    ("nassau_north", 40.80, -73.74, 40.90, -73.68),
]


def main():
    os.makedirs(RAW, exist_ok=True)
    for name, s, w, n, e in BOXES:
        p = os.path.join(RAW, f"bbox_{name}.json.gz")
        if os.path.exists(p):
            continue
        t0 = time.time()
        d = overpass(f'[out:json][timeout:600];way["building"]({s},{w},{n},{e});out tags geom;')
        if d is None:
            print(f"  {name}: failed, rerun later", flush=True)
            continue
        gzip.open(p, "wt").write(json.dumps(d))
        print(f"  {name}: {len(d.get('elements', []))} buildings in {time.time() - t0:.0f} s", flush=True)
        time.sleep(2)


if __name__ == "__main__":
    main()
