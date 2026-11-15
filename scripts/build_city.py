"""Buildings, exposure, street trees and porosity for the browser.

Buildings: the city's 1.08 million footprints with measured roof heights (NYC
Open Data), simplified at 0.5 m; outside the city, OpenStreetMap buildings for
context. Ground level at each building comes from the model DEM.
Exposure: USACE National Structure Inventory points joined to footprints (point
in polygon, then the nearest footprint within 12 m), values summed, the most
valuable structure setting occupancy, foundation and first-floor height.
Street trees: the 2015 NYC Street Tree Census, living trees.

Outputs in web/data/:
  chunks/c_I_J.bin.gz  buildings below 40 m and street trees, per 1600 m chunk
  tall.bin.gz          buildings 40 m and taller (always drawn)
  exposure.bin.gz      one 16-byte record per NYC building (see EXPO below)
  por_20m.bin.gz       building cover fraction x 250 on the 20 m grid (row 0 = south)
  city.json            chunk index, archetypes, neighbourhoods, class names, counts
"""
from __future__ import annotations

import gzip
import json
import math
import os
import pickle
import struct
import sys
from collections import Counter

import numpy as np
import shapely
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely import GeometryType

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import grid, to_utm  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
PROC = os.path.join(ROOT, "data", "processed")
WEB = os.path.join(ROOT, "web", "data")
CHUNK = 1600.0
TALL = 40.0
Q = 0.25                       # vertex quantum, m
FT = 0.3048
CLASS_NAMES = ["Residential, low-rise", "Residential, mid/high-rise", "Commercial and office",
               "Industrial and utility", "Institutional", "Garage or shed"]
ARCHETYPES = ["RES.SF.1.SLAB", "RES.SF.1.CRAWL", "RES.SF.2.SLAB", "RES.SF.2.BASEMENT", "RES.SF.1.ELEV_ENCL",
              "RES.SF.MH.UNK", "RES.MF2_4.2.UNK", "COM.MIXED.1.UNK"]
BORO_CODE = {"Manhattan": 1, "Bronx": 2, "Brooklyn": 3, "Queens": 4, "Staten Island": 5}
COUNTY_TO_BORO = {"Bronx": 2, "Brooklyn": 3, "Manhattan": 1, "Queens": 4, "Staten Island": 5}


def archetype(occ, found, stories):
    o = occ.split("-")[0]
    if o == "RES1":
        if stories >= 2:
            return "RES.SF.2.BASEMENT" if found == "B" else "RES.SF.2.SLAB"
        return {"S": "RES.SF.1.SLAB", "C": "RES.SF.1.CRAWL", "B": "RES.SF.2.BASEMENT", "P": "RES.SF.1.ELEV_ENCL",
                "I": "RES.SF.1.ELEV_ENCL", "W": "RES.SF.1.ELEV_ENCL"}.get(found, "RES.SF.1.SLAB")
    if o == "RES2":
        return "RES.SF.MH.UNK"
    if o.startswith("RES"):
        return "RES.MF2_4.2.UNK"
    return "COM.MIXED.1.UNK"


def classify(occ, stories, height, feature):
    if feature == "5110":
        return 5
    if occ:
        o = occ.split("-")[0]
        if o.startswith("COM6") or o.startswith(("EDU", "REL", "GOV")):
            return 4
        if o.startswith("IND"):
            return 3
        if o.startswith("COM"):
            return 2
        if o.startswith("RES3") and (stories or 0) >= 5:
            return 1
        if o.startswith("RES"):
            return 0
    return 1 if height > 22 else 0


def logq(v):
    """Values to uint16 codes, 1% steps: v = 1.01 ** code."""
    v = np.asarray(v, np.float64)
    return np.where(v >= 1, np.clip(np.round(np.log(np.maximum(v, 1)) / math.log(1.01)), 1, 65535), 0).astype(np.uint16)


def dem_sampler(g):
    dem = np.load(os.path.join(PROC, "terrain.npz"))["dem10"]
    H, W = dem.shape

    def at(x, y):                                 # local metres (east, north)
        c = np.clip(x / 10.0 - 0.5, 0, W - 1.001); r = np.clip((g["height_m"] - y) / 10.0 - 0.5, 0, H - 1.001)
        return ndimage.map_coordinates(dem, [r, c], order=1)
    return at


# ---------------------------------------------------------------- loading
def load_nyc(g):
    """Footprints as one MultiPolygon array in local metres plus attribute arrays."""
    coords, ring_off, poly_off, geom_off = [], [0], [0], [0]
    attrs = {"bin": [], "h": [], "g": [], "yr": [], "fc": []}
    nv = 0
    for k in range(100):
        p = os.path.join(RAW, "nyc_bldg", f"page_{k:02d}.json.gz")
        if not os.path.exists(p):
            break
        for r in json.loads(gzip.open(p).read()):
            geom = r.get("the_geom")
            if not geom or geom.get("type") != "MultiPolygon":
                continue
            for poly in geom["coordinates"]:
                for ring in poly:
                    coords.append(ring); nv += len(ring); ring_off.append(nv)
                poly_off.append(len(ring_off) - 1)
            geom_off.append(len(poly_off) - 1)
            attrs["bin"].append(int(r.get("bin") or 0))
            attrs["h"].append(float(r.get("height_roof") or 0) * FT)
            attrs["g"].append(float(r.get("ground_elevation") or 0) * FT)
            attrs["yr"].append(int(float(r.get("construction_year") or 0)))
            attrs["fc"].append(str(r.get("feature_code") or ""))
        print(f"  page {k}: {len(attrs['bin']):,} footprints", flush=True)
    xy = np.concatenate([np.asarray(c, np.float64) for c in coords])
    x, y = to_utm(xy[:, 0], xy[:, 1])
    xy = np.column_stack([np.asarray(x) - g["x0"], np.asarray(y) - g["y0"]])
    geoms = shapely.from_ragged_array(GeometryType.MULTIPOLYGON, xy,
                                      (np.array(ring_off), np.array(poly_off), np.array(geom_off)))
    return geoms, {k: np.array(v) for k, v in attrs.items()}


def osm_height(t):
    for key in ("height", "building:height"):
        v = t.get(key)
        if v:
            try:
                return float(str(v).lower().replace("m", "").replace("'", "").split(";")[0].strip())
            except ValueError:
                pass
    lv = t.get("building:levels")
    if lv:
        try:
            return float(str(lv).split(";")[0]) * 3.2 + 1.0
        except ValueError:
            pass
    b = (t.get("building") or "yes").lower()
    return {"house": 7.0, "detached": 7.0, "semidetached_house": 8.0, "terrace": 9.0, "residential": 9.0,
            "apartments": 14.0, "garage": 3.0, "garages": 3.0, "shed": 2.5, "commercial": 7.0, "retail": 6.0,
            "industrial": 9.0, "warehouse": 9.0, "school": 10.0, "church": 12.0}.get(b, 8.0)


def load_context(g, nyc_land):
    polys, hs, cls = [], [], []
    seen = set()                                    # tiles and boxes overlap: keep each way once
    d = os.path.join(RAW, "osm_ctx")
    for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        for e in json.loads(gzip.open(os.path.join(d, f), "rt").read()).get("elements", []):
            geo = e.get("geometry")
            if e.get("type") != "way" or not geo or len(geo) < 4 or e.get("id") in seen:
                continue
            seen.add(e.get("id"))
            a = np.array([[p["lon"], p["lat"]] for p in geo])
            x, y = to_utm(a[:, 0], a[:, 1])
            polys.append(np.column_stack([np.asarray(x) - g["x0"], np.asarray(y) - g["y0"]]))
            t = e.get("tags", {})
            hs.append(osm_height(t))
            b = (t.get("building") or "yes").lower()
            cls.append(5 if b in ("garage", "garages", "shed") else 3 if b in ("industrial", "warehouse") else
                       2 if b in ("commercial", "office", "retail", "hotel") else 4 if b in ("school", "church", "hospital", "university") else
                       1 if hs[-1] > 22 else 0)
    if not polys:
        return np.array([], dtype=object), np.zeros(0), np.zeros(0, np.uint8)
    geoms = shapely.make_valid(np.array([shapely.Polygon(q) for q in polys], dtype=object))
    inside = shapely.contains(nyc_land, shapely.centroid(geoms))
    keep = ~inside & (shapely.area(geoms) > 8)
    print(f"  context buildings: {int(keep.sum()):,} (dropped {int(inside.sum()):,} inside the city)")
    return geoms[keep], np.array(hs)[keep], np.array(cls, np.uint8)[keep]


# ---------------------------------------------------------------- encoding
def signed_area(r):
    x, y = r[:, 0], r[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))


def rings_of(geom):
    """List of (exterior, holes) without the closing vertex; exteriors counter-clockwise,
    holes clockwise, so a reader can tell them apart by orientation."""
    out = []
    for poly in getattr(geom, "geoms", [geom]):
        if poly.geom_type != "Polygon" or poly.is_empty:
            continue
        ext = np.asarray(poly.exterior.coords)[:-1]
        if len(ext) < 3:
            continue
        if signed_area(ext) < 0:
            ext = ext[::-1]
        holes = []
        for r in poly.interiors:
            h = np.asarray(r.coords)[:-1]
            if len(h) >= 3 and abs(signed_area(h)) > 30:
                holes.append(h[::-1] if signed_area(h) > 0 else h)
        out.append((ext, holes))
    return out


def encode_chunk(origin, recs, trees, absolute=False):
    """recs: list of (id, h_m, g_m, cls, (r,g,b), [rings...]) ; trees: (x, y, dbh, sp) arrays."""
    ids, hh, gg, cc, rc, roof, rlen, verts = [], [], [], [], [], [], [], []
    for bid, h, gnd, c, col, rings in recs:
        ids.append(bid); hh.append(min(65535, int(round(h * 10)))); gg.append(int(round(gnd * 100)))
        cc.append(c); roof.extend(col)
        rs = []
        for ext, holes in rings:
            rs.append(ext); rs.extend(holes)
        rs = rs[:255]
        rc.append(len(rs))
        for r in rs:
            q = np.round((r - origin) / Q).astype(np.int64)
            rlen.append(len(q))
            if absolute:
                verts.append(q.astype(np.int32).ravel())
            else:
                d = q.copy(); d[1:] = q[1:] - q[:-1]
                verts.append(np.clip(d, -32768, 32767).astype(np.int16).ravel())
    nB, nR = len(ids), len(rlen)
    V = np.concatenate(verts) if verts else np.zeros(0, np.int16)
    tx, ty, td, tsp = trees
    head = struct.pack("<4sIIIIffII", b"FTC2", 1 if absolute else 0, nB, nR, len(V) // 2, float(origin[0]), float(origin[1]), len(tx), 0)
    parts = [head, np.array(ids, np.uint32).tobytes(), np.array(hh, np.uint16).tobytes(), np.array(gg, np.int16).tobytes(),
             np.array(cc, np.uint8).tobytes(), np.array(rc, np.uint8).tobytes(), np.array(roof, np.uint8).tobytes()]
    def pad(b):
        return b + b"\0" * ((-len(b)) % 4)
    body = pad(b"".join(parts))
    body += pad(np.array(rlen, np.uint16).tobytes())
    body += pad(V.tobytes())
    if len(tx):
        tq = np.round((np.column_stack([tx, ty]) - origin) / Q).astype(np.int16)
        body += pad(tq.tobytes()) + pad(np.asarray(td, np.uint8).tobytes()) + pad(np.asarray(tsp, np.uint8).tobytes())
    return gzip.compress(body, 9)


# ---------------------------------------------------------------- main
def main():
    os.makedirs(os.path.join(WEB, "chunks"), exist_ok=True)
    g = grid()
    W, H = g["width_m"], g["height_m"]
    zat = dem_sampler(g)

    cache = os.path.join(PROC, "city_stage1.pkl")
    if os.path.exists(cache) and "--fresh" not in sys.argv:
        st = pickle.load(open(cache, "rb"))
        geoms = shapely.from_wkb(st.pop("wkb"))
        locals_ = st
        A, n, cen, cxy, boro, nta, ntas, nyc_land = st["A"], st["n"], shapely.points(st["cxy"]), st["cxy"], st["boro"], st["nta"], st["ntas"], shapely.from_wkb(st["nyc_land"])
        VS, VC, POP, storeys, ffh, arch, cls, roof, has = st["VS"], st["VC"], st["POP"], st["storeys"], st["ffh"], st["arch"], st["cls"], st["roof"], st["has"]
        occ = st["occ"]
        img = np.load(os.path.join(RAW, "imagery_5m.npy"))
        def colour_at(xy):
            c = np.clip(((xy[:, 0]) / 5.0).astype(int), 1, img.shape[1] - 2)
            r = np.clip(((H - xy[:, 1]) / 5.0).astype(int), 1, img.shape[0] - 2)
            stack = np.stack([img[r + dr, c + dc] for dr in (-1, 0, 1) for dc in (-1, 0, 1)])
            return np.median(stack, axis=0).astype(np.uint8)
        print(f"loaded NYC stage from cache: {n:,} buildings")
    else:
        print("NYC footprints ...")
        geoms, A = load_nyc(g)
        geoms = shapely.make_valid(shapely.simplify(geoms, 0.5, preserve_topology=True))
        area = shapely.area(geoms)
        ok = (area > 8) & ~shapely.is_empty(geoms)
        geoms = geoms[ok]; A = {k: v[ok] for k, v in A.items()}; area = area[ok]
        n = len(geoms)
        cen = shapely.point_on_surface(geoms)
        cxy = shapely.get_coordinates(cen)
        A["h"] = np.where(A["h"] > 1.5, A["h"], np.where(A["fc"] == "5110", 3.0, 6.0))
        print(f"  {n:,} footprints kept; height from data for {(A['h'] > 1.5).sum():,}")

        # boroughs and neighbourhoods
        bfe = json.load(open(os.path.join(RAW, "boroughs.geojson")))["features"]
        def proj_geom(feature):
            geom = shapely.geometry.shape(feature["geometry"])
            return shapely.transform(geom, lambda c: np.column_stack([np.asarray(to_utm(c[:, 0], c[:, 1])[0]) - g["x0"],
                                                                       np.asarray(to_utm(c[:, 0], c[:, 1])[1]) - g["y0"]]))
        boro_geoms = {f["properties"].get("boroname"): proj_geom(f) for f in bfe}
        nyc_land = shapely.union_all(list(boro_geoms.values()))
        boro = np.zeros(n, np.uint8)
        for name, bg in boro_geoms.items():
            boro[shapely.contains(bg, cen)] = BORO_CODE[name]
        nf = json.load(open(os.path.join(RAW, "nta2020.geojson")))["features"]
        nta_geoms = [proj_geom(f) for f in nf]
        nta_tree = shapely.STRtree(nta_geoms)
        pi, ti = nta_tree.query(cen, predicate="within")
        nta = np.full(n, 65535, np.uint16); nta[pi] = ti
        near = nta == 65535
        if near.any():
            nta[near] = nta_tree.query_nearest(cen[near], all_matches=False)[1]
        ntas = [{"code": f["properties"].get("nta2020"), "name": f["properties"].get("ntaname"),
                 "boro": BORO_CODE.get(f["properties"].get("boroname"), 0),
                 "x": round(float(shapely.get_coordinates(shapely.point_on_surface(ng))[0, 0]), 1),
                 "y": round(float(shapely.get_coordinates(shapely.point_on_surface(ng))[0, 1]), 1)} for f, ng in zip(nf, nta_geoms)]
        boro = np.where(boro == 0, np.array([n_["boro"] for n_ in ntas], np.uint8)[nta], boro)

        # ---- NSI join
        print("NSI join ...")
        S = np.load(os.path.join(RAW, "nsi_nyc.npz"), allow_pickle=True)
        sx, sy = to_utm(S["lon"], S["lat"])
        sxy = np.column_stack([np.asarray(sx) - g["x0"], np.asarray(sy) - g["y0"]])
        spts = shapely.points(sxy)
        tree = shapely.STRtree(geoms)
        si, bi = tree.query(spts, predicate="intersects")
        owner = np.full(len(spts), -1, np.int64)
        owner[si] = bi                                            # last match wins for overlapping footprints
        un = np.nonzero(owner < 0)[0]
        if len(un):
            ui, ub = tree.query_nearest(spts[un], max_distance=12.0, all_matches=False)
            owner[un[ui]] = ub
        m = owner >= 0
        print(f"  structures matched {int(m.sum()):,} of {len(owner):,}")
        vs = np.nan_to_num(S["val_struct"]); vc = np.nan_to_num(S["val_cont"])
        pop = np.nan_to_num(S["pop2amu65"]) + np.nan_to_num(S["pop2amo65"])
        VS = np.bincount(owner[m], vs[m], n); VC = np.bincount(owner[m], vc[m], n); POP = np.bincount(owner[m], pop[m], n)
        storeys = np.zeros(n); np.maximum.at(storeys, owner[m], np.nan_to_num(S["num_story"])[m])
        # the most valuable structure in each footprint sets occupancy, foundation, first-floor height
        order = np.argsort(vs[m])
        o_b = owner[m][order]; o_i = np.nonzero(m)[0][order]
        main_idx = np.full(n, -1, np.int64); main_idx[o_b] = o_i
        has = main_idx >= 0
        occ = np.where(has, S["occtype"][np.maximum(main_idx, 0)], "")
        fnd = np.where(has, S["found_type"][np.maximum(main_idx, 0)], "")
        ffh = np.where(has, np.nan_to_num(S["found_ht"][np.maximum(main_idx, 0)]) * FT, 0.0)
        est_st = np.maximum(1, np.round(A["h"] / 3.1))
        storeys = np.where(storeys > 0, storeys, est_st)
        arch = np.full(n, 255, np.uint8)
        for k in np.nonzero(has)[0]:
            arch[k] = ARCHETYPES.index(archetype(str(occ[k]), str(fnd[k]), storeys[k]))
        cls = np.array([classify(str(occ[k]), storeys[k], A["h"][k], A["fc"][k]) for k in range(n)], np.uint8)
        print(f"  buildings with exposure {int(has.sum()):,}; structure value ${VS.sum() / 1e9:,.1f}B; residents {POP.sum():,.0f}")
        print("  archetypes", Counter(ARCHETYPES[a] if a < 255 else "none" for a in arch).most_common())

        # ground from the DEM (minimum over the footprint's corners, so walls meet sloping ground)
        gc = zat(cxy[:, 0], cxy[:, 1])
        print(f"  ground: data minus DEM, median {np.median(A['g'] - gc):+.2f} m")

        # ---- roof colours from the imagery
        img = np.load(os.path.join(RAW, "imagery_5m.npy"))
        def colour_at(xy):
            c = np.clip(((xy[:, 0]) / 5.0).astype(int), 1, img.shape[1] - 2)
            r = np.clip(((H - xy[:, 1]) / 5.0).astype(int), 1, img.shape[0] - 2)
            stack = np.stack([img[r + dr, c + dc] for dr in (-1, 0, 1) for dc in (-1, 0, 1)])
            return np.median(stack, axis=0).astype(np.uint8)
        roof = colour_at(cxy)


        pickle.dump({"wkb": shapely.to_wkb(geoms), "A": A, "n": n, "cxy": cxy, "boro": boro, "nta": nta, "ntas": ntas,
                     "nyc_land": shapely.to_wkb(nyc_land), "VS": VS, "VC": VC, "POP": POP, "storeys": storeys, "ffh": ffh,
                     "arch": arch, "cls": cls, "roof": roof, "has": has, "occ": occ}, open(cache, "wb"))

    # ---- context buildings
    print("context buildings ...")
    cgeoms, ch, ccls = load_context(g, nyc_land)
    if len(cgeoms):
        cgeoms = shapely.simplify(cgeoms, 0.5, preserve_topology=True)
        ccen = shapely.get_coordinates(shapely.point_on_surface(cgeoms))
        croof = colour_at(ccen)
    else:
        ccen = np.zeros((0, 2)); croof = np.zeros((0, 3), np.uint8)

    # ---- porosity: building cover on a 5 m canvas, averaged to 20 m
    print("cover raster ...")
    canvas = Image.new("L", (int(W / 5), int(H / 5)), 0)
    dr = ImageDraw.Draw(canvas)
    def draw(geom):
        for ext, holes in rings_of(geom):
            dr.polygon([(px / 5.0, (H - py) / 5.0) for px, py in ext], fill=255)
            for h_ in holes:
                dr.polygon([(px / 5.0, (H - py) / 5.0) for px, py in h_], fill=0)
    for geo in geoms:
        draw(geo)
    for geo in cgeoms:
        draw(geo)
    cov = np.asarray(canvas, np.float32) / 255.0
    cov20 = cov.reshape(cov.shape[0] // 4, 4, cov.shape[1] // 4, 4).mean(axis=(1, 3))
    por = np.round(np.clip(cov20, 0, 1) * 250).astype(np.uint8)[::-1]
    open(os.path.join(WEB, "por_20m.bin.gz"), "wb").write(gzip.compress(np.ascontiguousarray(por).tobytes(), 9))
    print(f"  mean cover on NYC land {cov20[::-1][np.load(os.path.join(PROC, 'terrain.npz'))['boro'][::-1] > 0].mean():.3f}")

    # ---- street trees
    print("street trees ...")
    T = json.loads(gzip.open(os.path.join(RAW, "street_trees.json.gz")).read())
    tl = np.array([[float(t["longitude"]), float(t["latitude"]), float(t.get("tree_dbh") or 0)] for t in T if t.get("longitude")])
    tx, ty = to_utm(tl[:, 0], tl[:, 1])
    tx = np.asarray(tx) - g["x0"]; ty = np.asarray(ty) - g["y0"]
    species = [t.get("spc_common") or "" for t in T if t.get("longitude")]
    top = [s for s, _ in Counter(species).most_common(15)]
    tsp = np.array([top.index(s) if s in top else 15 for s in species], np.uint8)
    tdbh = np.clip(tl[:, 2], 1, 255).astype(np.uint8)
    print(f"  {len(tx):,} trees; top species {top[:6]}")

    # ---- ids, chunks and files
    print("writing chunks ...")
    ci = np.floor(cxy[:, 0] / CHUNK).astype(int); cj = np.floor(cxy[:, 1] / CHUNK).astype(int)
    key = cj * 1000 + ci
    order = np.lexsort((cxy[:, 0], key))                    # NYC ids follow chunk order
    nid = np.empty(n, np.int64); nid[order] = np.arange(n)
    nC = len(cgeoms)
    cci = np.floor(ccen[:, 0] / CHUNK).astype(int) if nC else np.zeros(0, int)
    ccj = np.floor(ccen[:, 1] / CHUNK).astype(int) if nC else np.zeros(0, int)
    cid = n + np.arange(nC)
    tci = np.floor(tx / CHUNK).astype(int); tcj = np.floor(ty / CHUNK).astype(int)
    tall_recs, chunks = [], []
    keys = sorted(set(key.tolist()) | set((ccj * 1000 + cci).tolist()) | set((tcj * 1000 + tci).tolist()))
    groups = {}
    for k in np.argsort(key, kind="stable"):
        groups.setdefault(int(key[k]), []).append(k)
    cgroups = {}
    for k in range(nC):
        cgroups.setdefault(int(ccj[k] * 1000 + cci[k]), []).append(k)
    tgroups = {}
    tkey = tcj * 1000 + tci
    for k in np.argsort(tkey, kind="stable"):
        tgroups.setdefault(int(tkey[k]), []).append(k)
    total_bytes = 0
    for kk in keys:
        j, i = divmod(kk, 1000)
        origin = np.array([i * CHUNK, j * CHUNK])
        recs, hmax = [], 0.0
        for k in groups.get(kk, []):
            rings = rings_of(geoms[k])
            if not rings:
                continue
            base = float(min(zat(r[0][:, 0], r[0][:, 1]).min() for r in rings))
            rec = (int(nid[k]), float(A["h"][k]), base, int(cls[k]), tuple(int(v) for v in roof[k]), rings)
            (tall_recs if A["h"][k] >= TALL else recs).append(rec)
            hmax = max(hmax, float(A["h"][k]))
        for k in cgroups.get(kk, []):
            rings = rings_of(cgeoms[k])
            if not rings:
                continue
            base = float(min(zat(r[0][:, 0], r[0][:, 1]).min() for r in rings))
            rec = (int(cid[k]), float(ch[k]), base, int(ccls[k]), tuple(int(v) for v in croof[k]), rings)
            (tall_recs if ch[k] >= TALL else recs).append(rec)
        tk = np.array(tgroups.get(kk, []), int)
        trees = (tx[tk], ty[tk], tdbh[tk], tsp[tk]) if len(tk) else (np.zeros(0), np.zeros(0), np.zeros(0), np.zeros(0))
        if not recs and not len(tk):
            continue
        b = encode_chunk(origin, recs, trees)
        open(os.path.join(WEB, "chunks", f"c_{i}_{j}.bin.gz"), "wb").write(b)
        total_bytes += len(b)
        chunks.append({"i": i, "j": j, "n": len(recs), "trees": int(len(tk)), "bytes": len(b), "hmax": round(hmax, 1)})
    tb = encode_chunk(np.array([0.0, 0.0]), tall_recs, (np.zeros(0), np.zeros(0), np.zeros(0), np.zeros(0)), absolute=True)
    open(os.path.join(WEB, "tall.bin.gz"), "wb").write(tb)
    print(f"  {len(chunks)} chunks, {total_bytes / 1e6:.1f} MB; tall buildings {len(tall_recs):,}, {len(tb) / 1e6:.2f} MB")

    # ---- exposure, one record per NYC building, in id order
    ex = np.zeros(n, dtype=[("x", "<u2"), ("y", "<u2"), ("arch", "u1"), ("ffh", "u1"), ("st", "u1"), ("boro", "u1"),
                            ("nta", "<u2"), ("vs", "<u2"), ("vc", "<u2"), ("pop", "<u2")])
    sc = 65535.0
    ex["x"][nid] = np.clip(np.round(cxy[:, 0] / W * sc), 0, 65535)
    ex["y"][nid] = np.clip(np.round(cxy[:, 1] / H * sc), 0, 65535)
    ex["arch"][nid] = arch
    ex["ffh"][nid] = np.clip(np.round(ffh * 10), 0, 255)
    ex["st"][nid] = np.clip(storeys, 1, 255)
    ex["boro"][nid] = boro
    ex["nta"][nid] = nta
    ex["vs"][nid] = logq(VS); ex["vc"][nid] = logq(VC)
    ex["pop"][nid] = np.clip(np.round(POP), 0, 65535)
    open(os.path.join(WEB, "exposure.bin.gz"), "wb").write(gzip.compress(ex.tobytes(), 9))

    np.savez_compressed(os.path.join(PROC, "buildings.npz"), nid=nid, cxy=cxy, h=A["h"], bin=A["bin"], yr=A["yr"], cls=cls,
                        arch=arch, ffh=ffh, storeys=storeys, boro=boro, nta=nta, vs=VS, vc=VC, pop=POP, occ=occ.astype(str))
    city = {"chunk": CHUNK, "tall": TALL, "quantum": Q, "nyc_buildings": n, "context_buildings": nC,
            "chunks": chunks, "class_names": CLASS_NAMES, "archetypes": ARCHETYPES, "ntas": ntas,
            "tree_species": top + ["Other"],
            "exposure": {"bytes": 16, "fields": ["x", "y", "arch", "ffh_dm", "storeys", "boro", "nta", "vs_code", "vc_code", "pop"],
                         "position_scale": [W / sc, H / sc], "value": "1.01 ** code (0 = none)"},
            "totals": {"value_struct": float(VS.sum()), "value_cont": float(VC.sum()), "residents": float(POP.sum()),
                       "with_exposure": int(has.sum()), "trees": int(len(tx))}}
    json.dump(city, open(os.path.join(WEB, "city.json"), "w"), separators=(",", ":"))
    print("done:", {k: v for k, v in city["totals"].items()})


if __name__ == "__main__":
    main()
