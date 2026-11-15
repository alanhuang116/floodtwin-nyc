"""Aerial imagery for the domain from the USGS National Map imagery basemap
(public domain): Web Mercator tiles at zoom 14 (about 7 m per pixel here),
mosaicked and resampled to a 5 m UTM 18N grid.

(The NAIP image service resets connections on large requests from this
machine; the cached basemap tiles are reliable. The browser loads the same
tiles at zoom 17 near the camera.)

    python scripts/fetch_imagery.py  ->  data/raw/imagery_5m.npy (uint8, H x W x 3, row 0 = north)
"""
from __future__ import annotations

import io
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import get, grid, to_lonlat  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
TILE_URL = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"
Z = 14
RES = 5.0


def merc(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / math.pi) / 2 * n
    return x, y


def main():
    g = grid()
    W, H = int(g["width_m"] / RES), int(g["height_m"] / RES)
    corners = [to_lonlat(x, y) for x in (g["x0"], g["x1"]) for y in (g["y0"], g["y1"])]
    lons, lats = zip(*corners)
    tx0, ty0 = merc(min(lons), max(lats), Z)
    tx1, ty1 = merc(max(lons), min(lats), Z)
    tx0, ty0, tx1, ty1 = int(tx0) - 1, int(ty0) - 1, int(tx1) + 1, int(ty1) + 1
    nx, ny = tx1 - tx0 + 1, ty1 - ty0 + 1
    print(f"tiles {nx} x {ny} = {nx * ny}", flush=True)
    cache = os.path.join(RAW, "tiles_z14")
    os.makedirs(cache, exist_ok=True)

    def one(xy):
        x, y = xy
        p = os.path.join(cache, f"{x}_{y}.jpg")
        if not os.path.exists(p):
            open(p, "wb").write(get(TILE_URL.format(z=Z, x=x, y=y), tries=10, timeout=60))
        return xy

    jobs = [(x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)]
    with ThreadPoolExecutor(6) as ex:
        for k, _ in enumerate(ex.map(one, jobs)):
            if k % 100 == 0:
                print(f"  {k}/{len(jobs)}", flush=True)
    mosaic = np.zeros((ny * 256, nx * 256, 3), np.uint8)
    for x, y in jobs:
        im = np.asarray(Image.open(os.path.join(cache, f"{x}_{y}.jpg")).convert("RGB"))
        mosaic[(y - ty0) * 256:(y - ty0 + 1) * 256, (x - tx0) * 256:(x - tx0 + 1) * 256] = im
    xs = g["x0"] + (np.arange(W) + 0.5) * RES
    out = np.zeros((H, W, 3), np.uint8)
    for r0 in range(0, H, 1024):                       # in bands to bound memory
        ys = g["y1"] - (np.arange(r0, min(H, r0 + 1024)) + 0.5) * RES
        X, Y = np.meshgrid(xs, ys)
        lon, lat = to_lonlat(X.ravel(), Y.ravel())
        mx, my = merc(np.asarray(lon), np.asarray(lat), Z)
        col, row = (mx - tx0) * 256 - 0.5, (my - ty0) * 256 - 0.5
        for c in range(3):
            out[r0:r0 + len(ys), :, c] = ndimage.map_coordinates(mosaic[:, :, c], [row, col], order=1).reshape(len(ys), W)
        print(f"  resampled rows {r0}", flush=True)
    np.save(os.path.join(RAW, "imagery_5m.npy"), out)
    json.dump({**g, "res": RES, "rows": H, "cols": W, "zoom": Z, "source": TILE_URL,
               "retrieved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
              open(os.path.join(RAW, "imagery_5m.json"), "w"), indent=1)
    print("done", out.shape, out.reshape(-1, 3).mean(0))


if __name__ == "__main__":
    main()
