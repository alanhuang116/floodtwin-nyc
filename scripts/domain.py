"""The model domain: New York City, the harbour and its shores.

All data are projected to NAD83 / UTM zone 18N (EPSG:26918) on one grid whose
origin is a multiple of 240 m, so the 10, 20, 40 and 80 m grids nest exactly.
Elevations are metres above NAVD88.
"""
from __future__ import annotations

import math
import time
import urllib.request

from pyproj import Transformer

EPSG = 26918
# The five boroughs with a margin: the Hudson shore of New Jersey and Newark Bay to
# the west, Raritan Bay to the south, the Nassau County line to the east and the
# Westchester line to the north.
LON_W, LON_E = -74.265, -73.695
LAT_S, LAT_N = 40.475, 40.925
STEP = 240

_fwd = Transformer.from_crs(4326, EPSG, always_xy=True)
_inv = Transformer.from_crs(EPSG, 4326, always_xy=True)


def to_utm(lon, lat):
    return _fwd.transform(lon, lat)


def to_lonlat(x, y):
    return _inv.transform(x, y)


def _snap(v, step, up):
    return (math.ceil(v / step) if up else math.floor(v / step)) * step


def grid():
    """Domain corners in UTM, snapped outward to 240 m."""
    xs, ys = zip(*(to_utm(lo, la) for lo in (LON_W, LON_E) for la in (LAT_S, LAT_N)))
    x0, x1 = _snap(min(xs), STEP, False), _snap(max(xs), STEP, True)
    y0, y1 = _snap(min(ys), STEP, False), _snap(max(ys), STEP, True)
    return {"epsg": EPSG, "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "width_m": x1 - x0, "height_m": y1 - y0}


def get(url, tries=8, timeout=300, headers=None):
    """GET with retries: several of the public map services reset connections now and then."""
    last = None
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 FloodTwin-NYC/1.0", **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            print("   retry", k + 1, str(e)[:120], flush=True)
            time.sleep(min(60, 3 * (k + 1)))
    raise RuntimeError(f"failed: {url[:120]} ({last})")


OVERPASS_MIRRORS = ["https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter",
                    "https://overpass-api.de/api/interpreter"]


def overpass(query, rounds=6, timeout=1000):
    """POST an Overpass query, rotating between public mirrors; returns parsed JSON or None."""
    import json as _json
    import urllib.parse as _up
    data = _up.urlencode({"data": query}).encode()
    for r in range(rounds):
        for url in OVERPASS_MIRRORS:
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": "FloodTwin-NYC/1.0 (research demo)",
                                                                     "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return _json.loads(resp.read())
            except Exception as e:  # noqa: BLE001
                print("   overpass", url.split("/")[2], str(e)[:80], flush=True)
        time.sleep(30 * (r + 1))
    return None


if __name__ == "__main__":
    g = grid()
    print(g, "cells at 40 m:", g["width_m"] // 40, "x", g["height_m"] // 40)
