"""USACE National Structure Inventory for the five boroughs, streamed per county
and reduced to the fields the loss model needs.

    python scripts/fetch_nsi.py  ->  data/raw/nsi_nyc.npz
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request

import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
URL = "https://nsi.sec.usace.army.mil/nsiapi/structures?fips={}&fmt=fs"
COUNTIES = {"36005": "Bronx", "36047": "Brooklyn", "36061": "Manhattan", "36081": "Queens", "36085": "Staten Island"}
NUM = ["found_ht", "num_story", "val_struct", "val_cont", "pop2amu65", "pop2amo65", "pop2pmu65", "pop2pmo65",
       "med_yr_blt", "ground_elv_m", "sqft"]
STR = ["occtype", "found_type", "bldgtype", "firmzone"]


def stream(fips):
    """Features one per line ('fs' format)."""
    for k in range(6):
        try:
            req = urllib.request.Request(URL.format(fips), headers={"User-Agent": "Mozilla/5.0 FloodTwin-NYC/1.0"})
            with urllib.request.urlopen(req, timeout=900) as r:
                for line in r:
                    line = line.strip().lstrip(b"").strip().rstrip(b",")   # RFC 8142 record separators
                    if line.startswith(b"{"):
                        yield json.loads(line)
            return
        except Exception as e:  # noqa: BLE001
            print("   retry", k + 1, str(e)[:120], flush=True)
            time.sleep(10 * (k + 1))
    raise SystemExit(f"NSI {fips} failed")


def main():
    cols = {k: [] for k in ["lon", "lat", "county", *NUM, *STR]}
    for c, (fips, name) in enumerate(COUNTIES.items()):
        n0 = len(cols["lon"])
        for f in stream(fips):
            p = f.get("properties", f)
            g = f.get("geometry") or {}
            xy = g.get("coordinates") or [p.get("x"), p.get("y")]
            cols["lon"].append(float(xy[0])); cols["lat"].append(float(xy[1])); cols["county"].append(c)
            for k in NUM:
                v = p.get(k)
                cols[k].append(float(v) if v not in (None, "") else np.nan)
            for k in STR:
                cols[k].append(str(p.get(k) or ""))
        print(f"{name}: {len(cols['lon']) - n0:,} structures", flush=True)
    arrs = {k: np.array(v, dtype=(np.float32 if k in NUM else np.float64 if k in ("lon", "lat") else np.int8 if k == "county" else object))
            for k, v in cols.items()}
    for k in STR:
        arrs[k] = arrs[k].astype(str)
    np.savez_compressed(os.path.join(ROOT, "data", "raw", "nsi_nyc.npz"), **arrs, counties=np.array(list(COUNTIES.values())))
    print("total", len(arrs["lon"]), "value", float(np.nansum(arrs["val_struct"])))


if __name__ == "__main__":
    main()
