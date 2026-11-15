"""Building footprints.

New York City: the city's Building Footprints dataset (NYC Open Data 5zhs-2jue,
1.08 million footprints with roof height and ground elevation), paged.
Context outside the city (New Jersey, Nassau and Westchester parts of the
domain): OpenStreetMap buildings from Overpass, in tiles.

    python scripts/fetch_buildings.py  ->  data/raw/nyc_bldg/page_NN.json.gz,
                                           data/raw/osm_ctx/tile_NN.json.gz
"""
from __future__ import annotations

import gzip
import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import LAT_N, LAT_S, LON_E, LON_W, get, overpass  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
NYC = "https://data.cityofnewyork.us/resource/5zhs-2jue.json"
OVERPASS = "https://overpass.private.coffee/api/interpreter"
PAGE = 50000


def nyc():
    out = os.path.join(RAW, "nyc_bldg")
    os.makedirs(out, exist_ok=True)
    total = int(json.loads(get(NYC + "?$select=count(*)"))[0]["count"])
    print("NYC footprints:", total, flush=True)
    for k, off in enumerate(range(0, total, PAGE)):
        p = os.path.join(out, f"page_{k:02d}.json.gz")
        if os.path.exists(p):
            continue
        q = {"$select": "the_geom,bin,construction_year,feature_code,ground_elevation,height_roof,last_status_type",
             "$order": "objectid", "$limit": PAGE, "$offset": off}
        b = get(NYC + "?" + urllib.parse.urlencode(q), timeout=600)
        n = len(json.loads(b))
        gzip.open(p, "wb").write(b)
        print(f"  page {k}: {n} rows, {len(b) / 1e6:.1f} MB", flush=True)


def context():
    out = os.path.join(RAW, "osm_ctx")
    os.makedirs(out, exist_ok=True)
    step = 0.1
    k = 0
    lat = LAT_S
    while lat < LAT_N - 1e-9:
        lon = LON_W
        while lon < LON_E - 1e-9:
            p = os.path.join(out, f"tile_{k:02d}.json.gz")
            s, w, n, e = lat, lon, min(lat + step, LAT_N), min(lon + step, LON_E)
            if not os.path.exists(p):
                q = f"""[out:json][timeout:900];
area["ISO3166-2"="US-NJ"]->.a; area["name"="Nassau County"]["admin_level"="6"]->.b;
area["name"="Westchester County"]["admin_level"="6"]->.c;
(way["building"](area.a)({s},{w},{n},{e}); way["building"](area.b)({s},{w},{n},{e});
 way["building"](area.c)({s},{w},{n},{e}););
out tags geom;"""
                d = overpass(q)
                if d is None:
                    print(f"  tile {k}: skipped, rerun later", flush=True)
                else:
                    gzip.open(p, "wt").write(json.dumps(d))
                    print(f"  tile {k} ({s:.2f},{w:.2f}): {len(d.get('elements', []))} buildings", flush=True)
                time.sleep(3)
            k += 1
            lon += step
        lat += step


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("all", "nyc"):
        nyc()
    if which in ("all", "context"):
        context()
