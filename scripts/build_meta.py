"""web/data/meta.json: grid, encodings, data sources and headline counts."""
from __future__ import annotations

import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PROC = os.path.join(ROOT, "data", "processed")
RAW = os.path.join(ROOT, "data", "raw")
WEB = os.path.join(ROOT, "web", "data")

SOURCES = [
    ("USGS 3DEP 1/3 arc-second DEM", "Terrain", "https://www.usgs.gov/3d-elevation-program", "dem_10m.json"),
    ("USGS National Map imagery basemap", "Aerial imagery", "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer", "imagery_5m.json"),
    ("NYC Building Footprints (NYC Open Data)", "Building shapes, roof heights", "https://data.cityofnewyork.us/d/5zhs-2jue", None),
    ("OpenStreetMap contributors (ODbL)", "Buildings outside the city", "https://www.openstreetmap.org/copyright", None),
    ("USACE National Structure Inventory", "Building values, occupancy, first-floor height, residents", "https://www.hec.usace.army.mil/confluence/nsi", None),
    ("NOAA CO-OPS 8518750 The Battery and 8516945 Kings Point", "Boundary water level", "https://tidesandcurrents.noaa.gov/", None),
    ("USGS 01311875 Rockaway Inlet and 01311850 Jamaica Bay at Inwood", "Boundary water level", "https://waterdata.usgs.gov/", None),
    ("USGS Short-Term Network, Hurricane Sandy high-water marks", "Validation", "https://stn.wim.usgs.gov/FEV/", None),
    ("NYC Sandy Inundation Zone (NYC Open Data)", "Validation", "https://data.cityofnewyork.us/d/5xsi-dfpx", None),
    ("NOAA Atlas 14 precipitation frequency", "Design rainfall", "https://hdsc.nws.noaa.gov/pfds/", None),
    ("FEMA National Flood Hazard Layer", "Effective flood zones", "https://www.fema.gov/flood-maps/national-flood-hazard-layer", None),
    ("NYC 2015 Street Tree Census", "Street trees", "https://data.cityofnewyork.us/d/uvpi-gqnh", None),
    ("MTA Subway Stations", "Critical assets", "https://data.ny.gov/d/39hk-dx4f", None),
    ("NYC Borough Boundaries and 2020 NTAs", "Aggregation", "https://data.cityofnewyork.us/d/9nt8-h7nd", None),
    ("FloodVuln Global (Entanglix)", "Damage ratios", "https://alanhuang116.github.io/floodvuln/", None),
]


def main():
    t = json.load(open(os.path.join(PROC, "terrain_meta.json")))
    city = json.load(open(os.path.join(WEB, "city.json")))
    src = []
    for name, use, url, f in SOURCES:
        when = None
        if f and os.path.exists(os.path.join(RAW, f)):
            when = json.load(open(os.path.join(RAW, f))).get("retrieved")
        src.append({"name": name, "use": use, "url": url, "retrieved": when or "2026-11-14"})
    meta = {"name": "New York City", "grid": t["grid"], "res": t["res"], "cols": t["cols"], "rows": t["rows"],
            "bw_res": t["bw_res"], "bw_cols": t["bw_cols"], "bw_rows": t["bw_rows"], "dem_encoding": t["dem_encoding"],
            "vertical_datum": "NAVD88 (m)", "crs": "NAD83 / UTM zone 18N (EPSG:26918)",
            "stats": {**t["stats"], "buildings": city["nyc_buildings"], "context_buildings": city["context_buildings"],
                      **city["totals"]},
            "sources": src}
    json.dump(meta, open(os.path.join(WEB, "meta.json"), "w"), indent=1)
    print(json.dumps(meta["stats"], indent=1))


if __name__ == "__main__":
    main()
