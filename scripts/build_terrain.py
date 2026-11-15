"""Terrain layers for the browser, on the 20 m model grid (row 0 = south).

  dem_20m.bin.gz    elevation, m NAVD88 (zigzag row differences at 1 cm); boundary
                    water carries an illustrative depth for rendering only
  cover_20m.bin.gz  uint8: 255 boundary water, otherwise vegetation fraction x 250
  boro_20m.bin.gz   uint8: 0 outside the city, 1 Manhattan, 2 Bronx, 3 Brooklyn,
                    4 Queens, 5 Staten Island
  fema_20m.bin.gz   uint8: 0 none, 1 0.2% annual chance, 2 A/AE/AO, 3 VE
  sandy_20m.bin.gz  uint8: 1 inside the mapped Hurricane Sandy inundation zone
  bw_80m.bin.gz     uint8 x 4: weights of the four boundary gauges for each cell
                    of boundary water, from distance along the water
  imagery.webp      ground texture, 3940 x 4096 (about 12.4 m per pixel)

Water: everything within the borough boundaries that include water but outside
the shoreline-clipped boundaries (so canals such as Gowanus and Newtown Creek
are water), plus the flat surfaces of the hydro-flattened DEM below 0.6 m
(tidal creeks and marsh flats among them) and areas outside the city the DEM
does not cover, kept where they connect to a large water body.
"""
from __future__ import annotations

import gzip
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import grid, to_utm  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
PROC = os.path.join(ROOT, "data", "processed")
WEB = os.path.join(ROOT, "web", "data")
BORO_CODE = {"Manhattan": 1, "Bronx": 2, "Brooklyn": 3, "Queens": 4, "Staten Island": 5}
GAUGES = [("8518750", -74.0142, 40.7006), ("8516945", -73.7649, 40.8103),
          ("01311875", -73.8855, 40.5742), ("01311850", -73.7576, 40.6175)]


def rasterize(features, g, res, value_of, shape, fill=0, dtype=np.uint8):
    """Polygons (lon/lat GeoJSON) to a raster with row 0 = north."""
    H, W = shape
    img = Image.new("I", (W, H), fill)
    dr = ImageDraw.Draw(img)

    def ring_px(ring):
        a = np.asarray(ring, dtype=np.float64)
        x, y = to_utm(a[:, 0], a[:, 1])
        return list(zip((np.asarray(x) - g["x0"]) / res, (g["y1"] - np.asarray(y)) / res))

    for f in features:
        v = value_of(f)
        if v is None:
            continue
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            dr.polygon(ring_px(poly[0]), fill=int(v))
            for hole in poly[1:]:
                dr.polygon(ring_px(hole), fill=fill)
    return np.asarray(img, dtype=np.int64).astype(dtype)


def block(a, f, fn=np.mean):
    H, W = a.shape[0] // f, a.shape[1] // f
    return fn(a[:H * f, :W * f].reshape(H, f, W, f), axis=(1, 3))


def write_gz(name, arr):
    b = gzip.compress(np.ascontiguousarray(arr).tobytes(), 9)
    open(os.path.join(WEB, name), "wb").write(b)
    return len(b)


def encode_dem(z):
    """Row-delta zigzag uint16 at 1 cm, offset 30 m (same scheme as FloodTwin)."""
    q = np.round((z + 30.0) * 100).astype(np.int64)
    d = q.copy(); d[:, 1:] = q[:, 1:] - q[:, :-1]
    zz = (d << 1) ^ (d >> 63)
    assert zz.max() < 65536, zz.max()
    return zz.astype(np.uint16)


def main():
    os.makedirs(WEB, exist_ok=True); os.makedirs(PROC, exist_ok=True)
    g = grid()
    dem = np.load(os.path.join(RAW, "dem_10m.npy"))
    dem[dem < -100] = np.nan
    H10, W10 = dem.shape

    # ---- water
    bc = json.load(open(os.path.join(RAW, "boroughs.geojson")))["features"]
    bw = json.load(open(os.path.join(RAW, "boroughs_water.geojson")))["features"]
    name = lambda f: f["properties"].get("boroname") or f["properties"].get("boro_name")  # noqa: E731
    land_nyc = rasterize(bc, g, 10, lambda f: BORO_CODE[name(f)], (H10, W10))
    wide_nyc = rasterize(bw, g, 10, lambda f: BORO_CODE[name(f)], (H10, W10))
    zf = np.nan_to_num(dem, nan=-50.0)
    rng = ndimage.maximum_filter(zf, 5) - ndimage.minimum_filter(zf, 5)
    flat = (rng < 1e-3) & (zf < 0.6)
    # hydro-flattened surfaces are water everywhere, including tidal creeks and marsh flats that
    # the shoreline-clipped borough polygons count as land (Jamaica Bay islands, Fresh Kills)
    water = flat | (np.isnan(dem) & (land_nyc == 0))
    water |= (wide_nyc > 0) & (land_nyc == 0)
    lab, n = ndimage.label(water)
    sizes = ndimage.sum(water, lab, np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool); keep[1:] = sizes >= 3000          # 0.3 km2 and up
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    keep[edge[edge > 0]] = True
    sea10 = keep[lab]
    print("water share", sea10.mean().round(3), "components kept", int(keep.sum()))

    # fill DEM holes on land from the nearest valid cell
    bad = np.isnan(dem)
    if bad.any():
        idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
        dem = dem[tuple(idx)]

    # ---- 20 m aggregation (row 0 north for now)
    f = 2
    seafrac = block(sea10.astype(np.float32), f)
    sea = seafrac > 0.5
    landz = np.where(sea10, np.nan, dem)
    with np.errstate(invalid="ignore"):
        z20 = np.nanmean(landz[:landz.shape[0] // f * f, :landz.shape[1] // f * f].reshape(H10 // f, f, W10 // f, f), axis=(1, 3))
    z20 = np.where(np.isnan(z20), block(dem, f), z20)
    # illustrative depth for boundary water (rendering only): deepens away from the shore
    dist = ndimage.distance_transform_edt(sea) * 20.0
    z20 = np.where(sea, -np.minimum(18.0, 2.5 + 0.009 * dist), z20)
    H20, W20 = z20.shape

    # ---- vegetation from the imagery (excess green), 5 m -> 20 m
    img = np.load(os.path.join(RAW, "imagery_5m.npy"))
    black = img.max(axis=2) < 6
    rgb = img.astype(np.float32)
    exg = (2 * rgb[..., 1] - rgb[..., 0] - rgb[..., 2]) / (rgb.sum(axis=2) + 1)
    veg5 = (exg > 0.06) & (rgb.sum(axis=2) > 90) & ~black
    veg20 = block(veg5.astype(np.float32), 4)[:H20, :W20]
    cover = np.where(sea, 255, np.round(np.clip(veg20, 0, 1) * 250)).astype(np.uint8)

    boro = block(land_nyc, f, lambda a, axis: np.max(a, axis=axis)).astype(np.uint8)
    boro = np.where(sea, 0, boro).astype(np.uint8)

    # ---- FEMA zones and the mapped Sandy inundation zone
    fz = json.load(open(os.path.join(RAW, "fema_zones.json")))["features"]
    def fcode(ft):
        p = ft["properties"]
        z = p.get("FLD_ZONE")
        if z == "VE":
            return 3
        if z in ("A", "AE", "AO"):
            return 2
        if z == "X" and "0.2" in str(p.get("ZONE_SUBTY") or ""):
            return 1
        return None
    order = sorted(fz, key=lambda ft: fcode(ft) or 0)
    fema = rasterize([ft for ft in order if fcode(ft)], g, 20, fcode, (H20, W20))
    sandy = rasterize(json.load(open(os.path.join(RAW, "sandy_inundation.geojson")))["features"], g, 20, lambda ft: 1, (H20, W20))
    sandy = np.where(sea, 0, sandy).astype(np.uint8)

    # ---- boundary gauge weights from distance along the water, at 80 m
    s80 = block(sea10.astype(np.float32), 8) > 0.35
    h80, w80 = s80.shape
    ids = -np.ones(s80.shape, np.int64); ids[s80] = np.arange(s80.sum())
    rows, cols, wts = [], [], []
    for dr, dc, w in [(0, 1, 1.0), (1, 0, 1.0), (1, 1, 1.4142), (1, -1, 1.4142)]:
        # node pairs (r, c) and (r + dr, c + dc)
        a = ids[max(0, -dr):h80 - max(0, dr), max(0, -dc):w80 - max(0, dc)]
        b = ids[max(0, dr):h80 + min(0, dr), max(0, dc):w80 + min(0, dc)]
        m = (a >= 0) & (b >= 0)
        rows += [a[m], b[m]]; cols += [b[m], a[m]]; wts += [np.full(m.sum(), w), np.full(m.sum(), w)]
    N = int(s80.sum())
    G = coo_matrix((np.concatenate(wts), (np.concatenate(rows), np.concatenate(cols))), shape=(N, N)).tocsr()
    src = []
    for gid, lon, lat in GAUGES:
        x, y = to_utm(lon, lat)
        r, c = int((g["y1"] - y) / 80), int((x - g["x0"]) / 80)
        rr, cc = np.nonzero(s80)
        k = int(np.argmin((rr - r) ** 2 + (cc - c) ** 2))
        src.append(k)
        print(f"gauge {gid}: water node {k} at ({rr[k]}, {cc[k]}), offset {np.hypot(rr[k] - r, cc[k] - c) * 80:.0f} m")
    D = dijkstra(G, indices=src) * 80.0                       # metres along the water
    D = np.where(np.isfinite(D), D, 1e9)
    inv = 1.0 / np.maximum(D, 400.0) ** 2
    Wn = inv / inv.sum(axis=0, keepdims=True)
    bw80 = np.zeros((h80, w80, 4), np.uint8)
    q = np.round(Wn.T * 255).astype(np.int64)
    q[:, 0] += 255 - q.sum(axis=1)                            # rounding residue to the Battery
    bw80[s80] = np.clip(q, 0, 255).astype(np.uint8)

    # ---- write (flip to row 0 = south)
    up = lambda a: np.ascontiguousarray(a[::-1])  # noqa: E731
    sizes = {
        "dem_20m.bin.gz": write_gz("dem_20m.bin.gz", encode_dem(up(z20))),
        "cover_20m.bin.gz": write_gz("cover_20m.bin.gz", up(cover)),
        "boro_20m.bin.gz": write_gz("boro_20m.bin.gz", up(boro)),
        "fema_20m.bin.gz": write_gz("fema_20m.bin.gz", up(fema)),
        "sandy_20m.bin.gz": write_gz("sandy_20m.bin.gz", up(sandy)),
        "bw_80m.bin.gz": write_gz("bw_80m.bin.gz", up(bw80)),
    }

    # ---- ground texture: open ocean the tile service leaves black gets a water colour
    base = img.copy()
    sea5 = np.repeat(np.repeat(sea10, 2, axis=0), 2, axis=1)[:base.shape[0], :base.shape[1]]
    base[black & sea5] = (38, 58, 66)
    tex = Image.fromarray(base).resize((3940, 4096), Image.LANCZOS)
    tex.save(os.path.join(WEB, "imagery.webp"), "WEBP", quality=82, method=6)
    sizes["imagery.webp"] = os.path.getsize(os.path.join(WEB, "imagery.webp"))

    np.savez_compressed(os.path.join(PROC, "terrain.npz"), z20=z20, sea=sea, cover=cover, boro=boro, fema=fema, sandy=sandy,
                        sea10=sea10, dem10=dem.astype(np.float32))
    meta = {"grid": g, "res": 20, "rows": H20, "cols": W20, "bw_res": 80, "bw_rows": h80, "bw_cols": w80,
            "dem_encoding": {"offset": 30.0, "scale": 0.01, "delta": "row", "zigzag": True},
            "gauges": [{"id": gid, "lon": lon, "lat": lat} for gid, lon, lat in GAUGES],
            "files": sizes, "stats": {"water_share": float(sea.mean()), "land_min": float(np.nanmin(np.where(sea, np.nan, z20))),
                                      "land_max": float(np.nanmax(z20)), "veg_share": float((veg20 > 0.5).mean())}}
    json.dump(meta, open(os.path.join(PROC, "terrain_meta.json"), "w"), indent=1)
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
