"""Bare-earth elevation for the domain from the USGS 3DEP 1/3 arc-second seamless
DEM (public domain), downloaded as the static 1x1 degree GeoTIFFs on Amazon S3
and resampled bilinearly to a 10 m grid in UTM 18N.

(The dynamic 3DEP image service resamples from the 1 m source on the fly and
times out on city-sized requests; the static tiles are reliable.)

    python scripts/fetch_dem.py   ->  data/raw/dem_10m.npy (float32, metres NAVD88,
                                       row 0 = north edge), data/raw/dem_10m.json
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request

import numpy as np
import tifffile
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import grid, to_lonlat  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
S3 = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/{t}/USGS_13_{t}.tif"
TILES = ["n41w075", "n41w074"]
RES = 10.0


def download(t):
    p = os.path.join(RAW, f"USGS_13_{t}.tif")
    if os.path.exists(p) and os.path.getsize(p) > 1e6:
        return p
    for k in range(6):
        try:
            urllib.request.urlretrieve(S3.format(t=t), p + ".part")
            os.replace(p + ".part", p)
            return p
        except Exception as e:  # noqa: BLE001
            print("   retry", k + 1, str(e)[:120], flush=True)
            time.sleep(10)
    raise SystemExit(f"download failed: {t}")


def read(p):
    with tifffile.TiffFile(p) as tf:
        page = tf.pages[0]
        a = page.asarray().astype(np.float32)
        tie = page.tags["ModelTiepointTag"].value          # (i, j, k, x, y, z)
        scale = page.tags["ModelPixelScaleTag"].value      # (sx, sy, sz)
        nod = page.tags.get("GDAL_NODATA")
    a[a < -1000] = np.nan
    if nod is not None:
        try:
            a[a == float(nod.value)] = np.nan
        except ValueError:
            pass
    return a, tie[3], tie[4], scale[0], scale[1]


def main():
    g = grid()
    W, H = int(round(g["width_m"] / RES)), int(round(g["height_m"] / RES))
    xs = g["x0"] + (np.arange(W) + 0.5) * RES
    ys = g["y1"] - (np.arange(H) + 0.5) * RES
    X, Y = np.meshgrid(xs, ys)
    lon, lat = to_lonlat(X.ravel(), Y.ravel())
    lon, lat = np.asarray(lon), np.asarray(lat)
    dem = np.full(W * H, np.nan, np.float32)
    for t in TILES:
        p = download(t)
        a, lon0, lat0, sx, sy = read(p)
        # pixel-is-area: tie point is the upper-left corner of the upper-left pixel
        col = (lon - lon0) / sx - 0.5
        row = (lat0 - lat) / sy - 0.5
        ok = (col >= 0) & (row >= 0) & (col <= a.shape[1] - 1) & (row <= a.shape[0] - 1)
        v = ndimage.map_coordinates(np.nan_to_num(a, nan=-9999), [row[ok], col[ok]], order=1, mode="nearest")
        v[v < -1000] = np.nan
        fill = ok.copy(); fill[ok] = np.isfinite(v)
        dem[fill] = v[np.isfinite(v)]
        print(t, a.shape, "covered", int(fill.sum()), flush=True)
        del a
    dem = dem.reshape(H, W)
    np.save(os.path.join(RAW, "dem_10m.npy"), dem)
    meta = {**g, "res": RES, "rows": H, "cols": W, "nodata_cells": int(np.isnan(dem).sum()),
            "min": float(np.nanmin(dem)), "max": float(np.nanmax(dem)),
            "source": "USGS 3DEP 1/3 arc-second DEM, " + ", ".join(TILES), "retrieved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    json.dump(meta, open(os.path.join(RAW, "dem_10m.json"), "w"), indent=1)
    print(meta)


if __name__ == "__main__":
    main()
