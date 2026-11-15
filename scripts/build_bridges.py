"""Bridges for the 3D scene from OpenStreetMap ways (data/raw/bridges.json.gz).

Named major bridges are grouped; each group's water crossing is found along its main
axis, and the deck follows a vertical curve to the bridge's navigation clearance over the
water, ramping down at about 4% to ground level plus a few metres on land. Suspension
bridges get towers at the ends of the main span and main cables; the Bayonne and Hell Gate
bridges get their arches. Other motorway bridges over water and long viaducts are drawn
as plain decks. Output: web/data/bridges.json (local metres, heights in m NAVD88).
"""
from __future__ import annotations

import gzip
import json
import math
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import grid, to_utm  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
PROC = os.path.join(ROOT, "data", "processed")

# name pattern: (key, clearance over water m, type, tower height above water m, main span m)
MAJOR = [
    (r"verrazz", "Verrazzano-Narrows Bridge", 69, "suspension", 211, 1298),
    (r"george washington", "George Washington Bridge", 65, "suspension", 184, 1067),
    (r"^brooklyn bridge$", "Brooklyn Bridge", 41, "suspension", 84, 486),
    (r"manhattan bridge", "Manhattan Bridge", 41, "suspension", 102, 448),
    (r"williamsburg bridge", "Williamsburg Bridge", 41, "suspension", 94, 488),
    (r"whitestone bridge", "Bronx-Whitestone Bridge", 46, "suspension", 115, 701),
    (r"throgs neck", "Throgs Neck Bridge", 43, "suspension", 110, 549),
    (r"queensboro", "Ed Koch Queensboro Bridge", 40, "truss", 0, 0),
    (r"kennedy bridge|triborough", "Robert F. Kennedy Bridge", 41, "truss", 0, 0),
    (r"bayonne bridge", "Bayonne Bridge", 66, "arch", 99, 504),
    (r"hell gate", "Hell Gate Bridge", 41, "arch", 93, 298),
    (r"goethals", "Goethals Bridge", 41, "deck", 0, 0),
    (r"outerbridge", "Outerbridge Crossing", 41, "truss", 0, 0),
    (r"marine parkway|gil hodges", "Marine Parkway-Gil Hodges Memorial Bridge", 17, "deck", 0, 0),
    (r"cross bay", "Cross Bay Veterans Memorial Bridge", 16, "deck", 0, 0),
    (r"henry hudson bridge", "Henry Hudson Bridge", 43, "deck", 0, 0),
    (r"alexander hamilton", "Alexander Hamilton Bridge", 31, "deck", 0, 0),
    (r"^washington bridge", "Washington Bridge", 41, "deck", 0, 0),
    (r"kosciuszko", "Kosciuszko Bridge", 27, "deck", 0, 0),
    (r"pulaski bridge", "Pulaski Bridge", 12, "deck", 0, 0),
    (r"newark bay", "Newark Bay Bridge", 41, "deck", 0, 0),
]


def main():
    g = grid()
    W, H = g["width_m"], g["height_m"]
    T = np.load(os.path.join(PROC, "terrain.npz"))
    dem, sea = T["dem10"], T["sea10"]
    R, C = dem.shape

    def cell(x, y):
        c = np.clip((np.asarray(x) / 10.0).astype(int), 0, C - 1)
        r = np.clip(((H - np.asarray(y)) / 10.0).astype(int), 0, R - 1)
        return r, c

    def ground(x, y):
        r, c = cell(x, y)
        return dem[r, c]

    def water(x, y):
        r, c = cell(x, y)
        return sea[r, c]

    d = json.loads(gzip.open(os.path.join(RAW, "bridges.json.gz")).read())
    groups, generic = {}, []
    for e in d["elements"]:
        geo = e.get("geometry")
        if not geo or len(geo) < 2:
            continue
        t = e.get("tags", {})
        a = np.array([[p["lon"], p["lat"]] for p in geo])
        x, y = to_utm(a[:, 0], a[:, 1])
        pts = np.column_stack([np.asarray(x) - g["x0"], np.asarray(y) - g["y0"]])
        if (pts[:, 0] < 0).all() or (pts[:, 0] > W).all() or (pts[:, 1] < 0).all() or (pts[:, 1] > H).all():
            continue
        name = (t.get("name") or t.get("bridge:name") or "").lower()
        lanes = float(str(t.get("lanes", "2")).split(";")[0] or 2) if str(t.get("lanes", "2")).split(";")[0].replace(".", "").isdigit() else 2
        hw = t.get("highway", "")
        width = 2.5 if hw in ("footway", "cycleway", "path") else (6.0 if t.get("railway") else max(6.0, lanes * 3.6))
        key = None
        for pat, k, *_ in MAJOR:
            if re.search(pat, name) or re.search(pat, (t.get("bridge:name") or "").lower()):
                key = k
                break
        if key:
            groups.setdefault(key, []).append((pts, width))
        else:
            seg = np.hypot(*np.diff(pts, axis=0).T).sum()
            wet = water(pts[:, 0], pts[:, 1]).mean()
            layer = float(str(t.get("layer", "1")).split(";")[0]) if str(t.get("layer", "1")).split(";")[0].lstrip("-").isdigit() else 1
            if layer < 1:
                continue
            if wet > 0.05 and seg > 40:
                generic.append((pts, width, "water", layer))
            elif seg > 140 and hw in ("motorway", "trunk"):
                generic.append((pts, width, "viaduct", layer))

    out = []
    for pat, key, clear, kind, tower_h, span in MAJOR:
        ways = groups.get(key)
        if not ways:
            continue
        allp = np.concatenate([w[0] for w in ways])
        ctr = allp.mean(axis=0)
        u, s_, vt = np.linalg.svd(allp - ctr, full_matrices=False)
        axis = vt[0]
        normal = np.array([-axis[1], axis[0]])
        s_all = (allp - ctr) @ axis
        s0, s1 = s_all.min(), s_all.max()
        ss = np.arange(s0, s1 + 1, 10.0)
        line = ctr + np.outer(ss, axis)
        wet = water(line[:, 0], line[:, 1])
        # longest run of water along the axis
        best, cur, start = (0, 0, 0), 0, 0
        for k, wv in enumerate(wet):
            if wv:
                if cur == 0:
                    start = k
                cur += 1
                if cur > best[0]:
                    best = (cur, start, k)
            else:
                cur = 0
        if best[0] == 0:
            w0 = w1 = (s0 + s1) / 2
        else:
            w0, w1 = ss[best[1]], ss[best[2]]
        mid, half = (w0 + w1) / 2, max(30.0, (w1 - w0) / 2)
        edge = 0.86 * clear

        def deck_z(px, py):
            s = (np.array([px, py]) - ctr) @ axis
            gz = float(ground(px, py))
            if w0 <= s <= w1:
                f = (s - mid) / half
                z = clear - (clear - edge) * f * f
            else:
                dist = (w0 - s) if s < w0 else (s - w1)
                z = edge - 0.04 * dist
            return max(z, gz + 5.5 if not water(px, py) else 2.0)

        bways = []
        for pts, width in ways:
            # densify long segments so the vertical curve is smooth
            dense = [pts[0]]
            for p0, p1 in zip(pts[:-1], pts[1:]):
                n = max(1, int(math.ceil(np.hypot(*(p1 - p0)) / 25.0)))
                for k in range(1, n + 1):
                    dense.append(p0 + (p1 - p0) * k / n)
            dense = np.array(dense)
            zs = [deck_z(px, py) for px, py in dense]
            bways.append({"w": round(width, 1), "p": [round(float(v), 1) for p, z in zip(dense, zs) for v in (p[0], p[1], z)]})
        rec = {"name": key, "type": kind, "clear": clear, "ways": bways}
        if kind == "suspension" and best[0] > 0:
            # towers at the ends of the main span, centred across the deck width
            off = ((allp - ctr) @ normal)
            width_all = off.max() - off.min()
            c0 = (off.max() + off.min()) / 2
            towers = []
            for sgn in (-1, 1):
                p = ctr + axis * (mid + sgn * span / 2) + normal * c0
                towers.append([round(float(p[0]), 1), round(float(p[1]), 1), tower_h, round(float(width_all + 6), 1)])
            rec["towers"] = towers
            # main cables: tower top to tower top with a sag of a ninth of the span, then down to the anchorages
            cables = []
            for side in (-1, 1):
                pts3 = []
                sA, sB = mid - span / 2, mid + span / 2
                anchor = span * 0.42
                for k in range(0, 61):
                    s = sA - anchor + (sB - sA + 2 * anchor) * k / 60
                    if s < sA:
                        z = tower_h - (tower_h - edge * 0.7) * ((sA - s) / anchor) ** 1.2
                    elif s > sB:
                        z = tower_h - (tower_h - edge * 0.7) * ((s - sB) / anchor) ** 1.2
                    else:
                        f = (s - mid) / (span / 2)
                        z = clear + 3 + (tower_h - clear - 3) * f * f
                    p = ctr + axis * s + normal * (c0 + side * (width_all / 2 + 1.5))
                    pts3 += [round(float(p[0]), 1), round(float(p[1]), 1), round(float(z), 1)]
                cables.append(pts3)
            rec["cables"] = cables
        if kind == "arch" and best[0] > 0:
            off = ((allp - ctr) @ normal)
            c0 = (off.max() + off.min()) / 2
            width_all = off.max() - off.min()
            arches = []
            for side in (-1, 1):
                pts3 = []
                for k in range(0, 49):
                    f = -1 + 2 * k / 48
                    s = mid + f * span / 2
                    z = 4 + (tower_h - 4) * (1 - f * f)
                    p = ctr + axis * s + normal * (c0 + side * (width_all / 2 + 1.0))
                    pts3 += [round(float(p[0]), 1), round(float(p[1]), 1), round(float(z), 1)]
                arches.append(pts3)
            rec["arches"] = arches
        out.append(rec)
        print(f"  {key}: {len(ways)} ways, water {w1 - w0:.0f} m, {kind}")

    gen = []
    for pts, width, what, layer in generic:
        zs = []
        for px, py in pts:
            gz = float(ground(px, py))
            zs.append(max(gz + 6.5 * layer, 9.0) if what == "water" else gz + 6.5 * layer)
        gen.append({"w": round(width, 1), "p": [round(float(v), 1) for p, z in zip(pts, zs) for v in (p[0], p[1], z)]})
    res = {"bridges": out, "decks": gen}
    path = os.path.join(ROOT, "web", "data", "bridges.json")
    json.dump(res, open(path, "w"), separators=(",", ":"))
    print(f"{len(out)} major bridges, {len(gen)} other decks, {os.path.getsize(path) / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
