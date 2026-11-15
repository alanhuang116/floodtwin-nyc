"""Vector layers: borough boundaries, 2020 neighbourhood tabulation areas, the
Hurricane Sandy inundation zone, subway stations, hospitals and FEMA flood zones.

    python scripts/fetch_vectors.py  ->  data/raw/*.json
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import LAT_N, LAT_S, LON_E, LON_W, get, overpass  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
OVERPASS = "https://overpass.private.coffee/api/interpreter"


def socrata_geojson(dataset, name, limit=50000):
    url = f"https://data.cityofnewyork.us/resource/{dataset}.geojson?$limit={limit}"
    b = get(url, timeout=600)
    d = json.loads(b)
    json.dump(d, open(os.path.join(RAW, name), "w"))
    print(name, len(d.get("features", [])), "features", flush=True)


def main():
    for ds, name in [("gthc-hcne", "boroughs.geojson"), ("9nt8-h7nd", "nta2020.geojson"), ("5xsi-dfpx", "sandy_inundation.geojson")]:
        if not os.path.exists(os.path.join(RAW, name)):
            socrata_geojson(ds, name)
    if not os.path.exists(os.path.join(RAW, "subway_stations.json")):
        b = get("https://data.ny.gov/resource/39hk-dx4f.json?$limit=5000")   # MTA Subway Stations
        json.dump(json.loads(b), open(os.path.join(RAW, "subway_stations.json"), "w"))
    if not os.path.exists(os.path.join(RAW, "street_trees.json.gz")):    # 2015 Street Tree Census, living trees
        import gzip
        q = {"$select": "tree_dbh,spc_common,latitude,longitude", "$where": "status='Alive'", "$limit": 800000}
        b = get("https://data.cityofnewyork.us/resource/uvpi-gqnh.json?" + urllib.parse.urlencode(q), timeout=1200)
        gzip.open(os.path.join(RAW, "street_trees.json.gz"), "wb").write(b)
        print("street trees", len(json.loads(b)), flush=True)

    q = f"""[out:json][timeout:300];
(nwr["amenity"="hospital"]({LAT_S},{LON_W},{LAT_N},{LON_E}););
out center tags;"""
    if not os.path.exists(os.path.join(RAW, "hospitals.json")):
        d = overpass(q, timeout=400)
        if d is not None:
            json.dump(d, open(os.path.join(RAW, "hospitals.json"), "w"))
            print("hospitals", len(d["elements"]), flush=True)

    # FEMA NFHL flood hazard zones, paged
    feats, off = [], 0
    while True:
        q = {"geometry": f"{LON_W},{LAT_S},{LON_E},{LAT_N}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
             "outSR": 4326, "spatialRel": "esriSpatialRelIntersects", "outFields": "FLD_ZONE,ZONE_SUBTY,STATIC_BFE,SFHA_TF",
             "where": "FLD_ZONE IN ('A','AE','AO','VE','X')", "resultOffset": off, "resultRecordCount": 500,
             "geometryPrecision": 6, "maxAllowableOffset": 0.00005, "f": "geojson"}
        d = json.loads(get("https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?" + urllib.parse.urlencode(q), timeout=600))
        fs = d.get("features", [])
        feats += fs
        print(f"  FEMA zones {len(feats)}", flush=True)
        if len(fs) < 500:
            break
        off += 500
        time.sleep(1)
    json.dump({"type": "FeatureCollection", "features": feats}, open(os.path.join(RAW, "fema_zones.json"), "w"))


if __name__ == "__main__":
    main()
