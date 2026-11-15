"""Major bridges from OpenStreetMap (road and rail ways tagged as bridges, by name),
for 3D decks and towers. Writes data/raw/bridges.json.gz."""
from __future__ import annotations

import gzip
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import overpass  # noqa: E402

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "raw")
BBOX = "40.48,-74.27,40.96,-73.68"
NAMES = ("Brooklyn Bridge|Manhattan Bridge|Williamsburg Bridge|Queensboro Bridge|Verrazzano|George Washington Bridge|"
         "Robert F. Kennedy Bridge|Triborough|Whitestone|Throgs Neck|Bayonne Bridge|Goethals|Outerbridge|Marine Parkway|"
         "Cross Bay|Hell Gate|Henry Hudson Bridge|Alexander Hamilton Bridge|Kosciuszko|Pulaski Bridge|Roosevelt Island Bridge|"
         "Third Avenue Bridge|Willis Avenue Bridge|Macombs Dam|Washington Bridge|Ward's Island|Wards Island|Pelham Bridge|"
         "Gil Hodges|Kill Van Kull|Newark Bay Bridge|Lincoln Highway|Victory Bridge|Hutchinson River")


def main():
    q = f"""[out:json][timeout:600];
(
  way["bridge"]["highway"~"^(motorway|trunk|primary|secondary|tertiary|footway|cycleway|path)$"]["name"~"{NAMES}"]({BBOX});
  way["bridge"]["railway"]["name"~"{NAMES}"]({BBOX});
  way["bridge"]["highway"~"^(motorway|trunk)$"]["layer"]({BBOX});
);
out tags geom;"""
    d = overpass(q)
    if d is None:
        raise SystemExit("bridges: overpass failed")
    out = os.path.join(RAW, "bridges.json.gz")
    gzip.open(out, "wt").write(json.dumps(d))
    names = {}
    for e in d.get("elements", []):
        n = e.get("tags", {}).get("name", "")
        names[n] = names.get(n, 0) + 1
    print(len(d.get("elements", [])), "ways;", sorted(names.items(), key=lambda x: -x[1])[:40])


if __name__ == "__main__":
    main()
