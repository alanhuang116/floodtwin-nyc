"""Water levels and rainfall statistics.

Boundary gauges (NAVD88), October 2012, six-minute values:
  NOAA CO-OPS 8518750 The Battery, 8516945 Kings Point
  USGS 01311875 Rockaway Inlet near Floyd Bennett Field, 01311850 Jamaica Bay at Inwood
NOAA Atlas 14 precipitation frequency at Central Park.
USGS STN Hurricane Sandy high-water marks (event 24), copied from the FloodTwin
download (data/raw/hwm_sandy.json there; 910 marks in New York and New Jersey).

    python scripts/fetch_events.py  ->  data/raw/gauges_2012.json, atlas14_cp.json, hwm_sandy.json
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import get  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
COOPS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
NWIS = "https://nwis.waterservices.usgs.gov/nwis/iv/"
FLOODTWIN_RAW = r"D:/_work_flood_simulation/data/raw"


def coops(station, begin, end):
    q = {"begin_date": begin, "end_date": end, "station": station, "product": "water_level", "datum": "NAVD",
         "units": "metric", "time_zone": "gmt", "format": "json", "application": "floodtwin_nyc"}
    d = json.loads(get(COOPS + "?" + urllib.parse.urlencode(q)))
    return [[r["t"], float(r["v"])] for r in d["data"] if r["v"] not in ("", None)], d["metadata"]


def nwis(site, begin, end):
    q = {"format": "json", "sites": site, "startDT": begin, "endDT": end, "parameterCd": "62620"}
    d = json.loads(get(NWIS + "?" + urllib.parse.urlencode(q)))
    ts = d["value"]["timeSeries"][0]
    info = ts["sourceInfo"]
    vals = []
    for v in ts["values"][0]["value"]:
        x = float(v["value"])
        if x > -999:
            vals.append([v["dateTime"], round(x * 0.3048, 4)])      # ft NAVD88 -> m
    geo = info["geoLocation"]["geogLocation"]
    return vals, {"id": info["siteCode"][0]["value"], "name": info["siteName"], "lat": geo["latitude"], "lon": geo["longitude"]}


def main():
    out = {}
    for sid in ("8518750", "8516945"):
        vals, meta = coops(sid, "20121001", "20121031")
        vals2, _ = coops(sid, "20121101", "20121102")
        out[sid] = {"source": "NOAA CO-OPS", "name": meta["name"], "lat": float(meta["lat"]), "lon": float(meta["lon"]),
                    "time_zone": "UTC", "values": vals + vals2}
        print(meta["name"], len(vals) + len(vals2), flush=True)
    for site in ("01311875", "01311850"):
        vals, meta = nwis(site, "2012-10-01T00:00Z", "2012-11-02T00:00Z")
        out[site] = {"source": "USGS NWIS", **meta, "time_zone": "offset in timestamp", "values": vals}
        print(meta["name"], len(vals), flush=True)
    json.dump(out, open(os.path.join(RAW, "gauges_2012.json"), "w"))

    a14 = get("https://hdsc.nws.noaa.gov/cgi-bin/hdsc/new/cgi_readH5.py?lat=40.7789&lon=-73.9692"
              "&type=pf&data=depth&units=metric&series=pds").decode("utf-8", "replace")
    json.dump({"raw": a14, "source": "https://hdsc.nws.noaa.gov/pfds/"}, open(os.path.join(RAW, "atlas14_cp.json"), "w"))
    print("Atlas 14:", len(a14), "chars")

    shutil.copy(os.path.join(FLOODTWIN_RAW, "hwm_sandy.json"), os.path.join(RAW, "hwm_sandy.json"))
    shutil.copy(os.path.join(FLOODTWIN_RAW, "floodvuln_model.json"), os.path.join(RAW, "floodvuln_model.json"))
    print("copied HWMs and FloodVuln model")


if __name__ == "__main__":
    main()
