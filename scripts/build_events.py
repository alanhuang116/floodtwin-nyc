"""Event, validation, vulnerability and asset data for the browser -> web/data/events.json

  - Boundary gauges (m NAVD88, 6 min): The Battery and Kings Point (NOAA CO-OPS),
    Rockaway Inlet and Jamaica Bay at Inwood (USGS). Observed records for
    Hurricane Sandy, and tidal constituents fitted to 1-25 October 2012 for
    synthetic events.
  - USGS STN Hurricane Sandy high-water marks inside the domain (NAVD88)
  - NOAA Atlas 14 precipitation frequency at Central Park
  - FloodVuln Global damage tables (mean, P10, P50, P90 damage ratio against
    depth above the first floor), NJ and NY calibration
  - Subway stations (MTA) and hospitals (OpenStreetMap), and place labels

    python scripts/build_events.py
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys

import numpy as np
from scipy.special import betaincinv, expit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import grid, to_utm  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
PROC = os.path.join(ROOT, "data", "processed")
WEB = os.path.join(ROOT, "web", "data")
T0 = dt.datetime(2012, 10, 28, tzinfo=dt.timezone.utc)
DURATIONS = ["5-min", "10-min", "15-min", "30-min", "60-min", "2-hr", "3-hr", "6-hr", "12-hr", "24-hr",
             "2-day", "3-day", "4-day", "7-day", "10-day", "20-day", "30-day", "45-day", "60-day"]
RETURN_PERIODS = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000]
GAUGE_ORDER = ["8518750", "8516945", "01311875", "01311850"]
SHORT = {"8518750": "The Battery", "8516945": "Kings Point", "01311875": "Rockaway Inlet", "01311850": "Jamaica Bay at Inwood"}
# constituent speeds, degrees per hour
SPEEDS = {"M2": 28.9841042, "S2": 30.0, "N2": 28.4397295, "K2": 30.0821373, "K1": 15.0410686, "O1": 13.9430356, "M4": 57.9682084}
LANDMARKS = [("Statue of Liberty", 40.6892, -74.0445), ("One World Trade Center", 40.7127, -74.0134),
             ("Empire State Building", 40.7484, -73.9857), ("Central Park", 40.7812, -73.9665),
             ("Brooklyn Bridge", 40.7061, -73.9969), ("JFK Airport", 40.6413, -73.7781), ("LaGuardia Airport", 40.7769, -73.8740),
             ("Newark Airport", 40.6895, -74.1745), ("Coney Island", 40.5749, -73.9859), ("Rockaway Beach", 40.5834, -73.8158),
             ("Breezy Point", 40.5560, -73.9270), ("Broad Channel", 40.6080, -73.8170), ("Howard Beach", 40.6571, -73.8430),
             ("Red Hook", 40.6750, -74.0110), ("Gowanus Canal", 40.6780, -73.9900), ("Battery Park City", 40.7110, -74.0160),
             ("Brooklyn Navy Yard", 40.7020, -73.9710), ("Hunts Point", 40.8094, -73.8803), ("Midland Beach", 40.5730, -74.0930),
             ("Governors Island", 40.6895, -74.0168), ("Hoboken", 40.7440, -74.0324), ("Jersey City", 40.7178, -74.0431),
             ("Long Island City", 40.7447, -73.9485), ("Prospect Park", 40.6602, -73.9690), ("Flushing Meadows", 40.7400, -73.8407)]
BOROUGH_LABELS = [("Manhattan", 40.7790, -73.9680), ("The Bronx", 40.8448, -73.8648), ("Brooklyn", 40.6500, -73.9496),
                  ("Queens", 40.7282, -73.7949), ("Staten Island", 40.5795, -74.1502)]


def tmin(ts):
    return (ts - T0).total_seconds() / 60.0


def parse_series(entry):
    out = []
    for t, v in entry["values"]:
        if "T" in t:
            ts = dt.datetime.fromisoformat(t)
        else:
            ts = dt.datetime.strptime(t, "%Y-%m-%d %H:%M").replace(tzinfo=dt.timezone.utc)
        out.append((tmin(ts.astimezone(dt.timezone.utc)), float(v)))
    out.sort()
    return np.array(out)


def fit_tide(series):
    """Least-squares harmonic fit on 1-25 October 2012 (before the storm). t in hours since T0."""
    t_h = series[:, 0] / 60.0
    m = (t_h >= -27 * 24) & (t_h <= -3 * 24)
    t, z = t_h[m], series[m, 1]
    cols = [np.ones_like(t)]
    for s in SPEEDS.values():
        w = np.radians(s)
        cols += [np.cos(w * t), np.sin(w * t)]
    X = np.column_stack(cols)
    coef, *_ = np.linalg.lstsq(X, z, rcond=None)
    resid = z - X @ coef
    cons = {}
    for k, name in enumerate(SPEEDS):
        a, b = coef[1 + 2 * k], coef[2 + 2 * k]
        cons[name] = {"amp": round(float(np.hypot(a, b)), 4), "phase_deg": round(float(np.degrees(np.arctan2(b, a))) % 360, 2)}
    return {"z0": round(float(coef[0]), 4), "constituents": cons, "rms_residual": round(float(resid.std()), 3), "n": int(m.sum())}


def hwms(g, boro20):
    d = json.load(open(os.path.join(RAW, "hwm_sandy.json")))
    H20 = boro20.shape[0]
    out = []
    for r in d:
        if not r.get("latitude") or r.get("elev_ft") in (None, "") or r.get("event_id") not in (24, None):
            continue
        if (r.get("vertical_datum_name") or "NAVD88") != "NAVD88":
            continue
        x, y = to_utm(float(r["longitude"]), float(r["latitude"]))
        lx, ly = x - g["x0"], y - g["y0"]
        if not (40 <= lx <= g["width_m"] - 40 and 40 <= ly <= g["height_m"] - 40):
            continue
        b = int(boro20[min(H20 - 1, int(ly / 20)), min(boro20.shape[1] - 1, int(lx / 20))])
        out.append({"id": r.get("id"), "x": round(lx, 1), "y": round(ly, 1), "lat": float(r["latitude"]), "lon": float(r["longitude"]),
                    "elev_m": round(float(r["elev_ft"]) * 0.3048, 3), "quality": (r.get("hwm_quality_name") or "").split(":")[0],
                    "type": r.get("hwm_type_name"), "env": r.get("environment"), "county": r.get("county_name"),
                    "state": r.get("state_name"), "boro": b,
                    "site": (r.get("site_description") or r.get("location_description") or "")[:120]})
    return out


def atlas14():
    raw = json.load(open(os.path.join(RAW, "atlas14_cp.json")))["raw"]
    def grab(name):
        m = re.search(name + r"\s*=\s*(\[\[.*?\]\]);", raw, re.S)
        return [[float(v) for v in row] for row in json.loads(m.group(1).replace("'", '"'))]
    return {"location": "Central Park, New York (40.779 N, 73.969 W)", "units": "mm", "series": "partial duration",
            "durations": DURATIONS, "return_periods_yr": RETURN_PERIODS,
            "depth": grab("quantiles"), "upper90": grab("upper"), "lower90": grab("lower")}


def fv_tables():
    m = json.load(open(os.path.join(RAW, "floodvuln_model.json")))
    knots, width, th = np.array(m["knots"]), m["width"], np.array(m["theta"])
    NK = len(knots); PB = NK + 1
    sp = lambda x: np.where(x > 30, x, np.log1p(np.exp(np.minimum(x, 30))))  # noqa: E731
    depths = np.round(np.arange(-1.5, 5.0001, 0.05), 2)

    def dist(d, off):
        B = expit((d[:, None] - knots[None, :]) / width)
        s0 = (B * sp(th[1:1 + NK])).sum(1); s1 = (B * sp(th[PB + 1:PB + 1 + NK])).sum(1)
        sm = (B * sp(th[2 * PB + 1:2 * PB + 1 + NK])).sum(1)
        dc = np.clip(d, -2, 8)
        p0 = np.clip(expit(th[0] - s0 + off[0]), 1e-6, 1 - 1e-6)
        p1c = np.clip(expit(th[PB] + s1 + off[1]), 1e-6, 1 - 1e-6)
        mu = np.clip(expit(th[2 * PB] + sm + off[2]), 1e-4, 1 - 1e-4)
        phi = np.clip(np.exp(th[3 * PB] + th[3 * PB + 1] * dc + off[3]), 0.6, 400)
        p1 = (1 - p0) * p1c; rest = (1 - p0) * (1 - p1c)
        a, b = mu * phi, (1 - mu) * phi

        def q(p):
            inner = np.clip((p - p0) / rest, 1e-9, 1 - 1e-9)
            v = betaincinv(a, b, inner)
            return np.where(p <= p0, 0.0, np.where(p >= 1 - p1, 1.0, v))
        mean = p1 + rest * mu
        return mean, q(0.1), q(0.5), q(0.9)

    tables = {}
    for A in m["archetypes"]:
        for region in ("NJ", "NY"):
            off = np.array(A["offsets"], float)
            lo = m["locals"].get(f"{A['key']}@{region}")
            if lo:
                off = off + np.array(lo["offsets"], float)
            mean, p10, p50, p90 = dist(depths, off)
            tables[f"{A['key']}@{region}"] = {"n_local": lo["n"] if lo else 0, "mean": np.round(mean, 4).tolist(),
                                              "p10": np.round(p10, 4).tolist(), "p50": np.round(p50, 4).tolist(),
                                              "p90": np.round(p90, 4).tolist()}
    return {"model": "FloodVuln Global", "model_version": m["model_version"], "depth_m": depths.tolist(),
            "depth_reference": "water surface minus first-floor elevation",
            "archetypes": {A["key"]: A["label"] for A in m["archetypes"]}, "tables": tables}


def local(lon, lat, g):
    x, y = to_utm(lon, lat)
    return round(float(x - g["x0"]), 1), round(float(y - g["y0"]), 1)


def main():
    g = grid()
    raw = json.load(open(os.path.join(RAW, "gauges_2012.json")))
    terr = np.load(os.path.join(PROC, "terrain.npz"))
    boro20 = terr["boro"][::-1]                                   # row 0 = south

    gauges, sandy = [], {}
    start, end = tmin(dt.datetime(2012, 10, 29, 20, tzinfo=dt.timezone.utc)), tmin(dt.datetime(2012, 10, 30, 8, tzinfo=dt.timezone.utc))
    grid_t = np.arange(start - 60, end + 61, 6.0)
    for gid in GAUGE_ORDER:
        e = raw[gid]
        s = parse_series(e)
        tide = fit_tide(s)
        z = np.interp(grid_t, s[:, 0], s[:, 1])
        sandy[gid] = np.round(z, 3).tolist()
        k = int(np.argmax(np.where((s[:, 0] > start) & (s[:, 0] < end), s[:, 1], -99)))
        x, y = local(e["lon"], e["lat"], g)
        gauges.append({"id": gid, "name": SHORT[gid], "full_name": e["name"], "source": e["source"], "lon": e["lon"], "lat": e["lat"],
                       "x": x, "y": y, "tide": tide,
                       "sandy_peak": {"z": round(float(s[k, 1]), 3), "time": (T0 + dt.timedelta(minutes=float(s[k, 0]))).isoformat()}})
        print(f"{SHORT[gid]:22s} peak {s[k, 1]:.2f} m at {(T0 + dt.timedelta(minutes=float(s[k, 0]))).strftime('%m-%d %H:%M')} UTC;"
              f" tide z0 {tide['z0']:+.2f} M2 {tide['constituents']['M2']['amp']:.2f} m @ {tide['constituents']['M2']['phase_deg']:.0f} deg;"
              f" fit rms {tide['rms_residual']:.2f} m")

    st = json.load(open(os.path.join(RAW, "subway_stations.json")))
    stations = []
    for s in st:
        try:
            lon, lat = float(s["gtfs_longitude"]), float(s["gtfs_latitude"])
        except (KeyError, ValueError):
            continue
        x, y = local(lon, lat, g)
        stations.append({"name": s.get("stop_name"), "routes": s.get("daytime_routes"), "structure": s.get("structure"),
                         "borough": s.get("borough"), "complex": s.get("complex_id"), "x": x, "y": y})
    hosp = []
    for e in json.load(open(os.path.join(RAW, "hospitals.json"))).get("elements", []):
        nm = (e.get("tags") or {}).get("name")
        c = e.get("center") or ({"lat": e.get("lat"), "lon": e.get("lon")} if e.get("lat") else None)
        if not nm or not c:
            continue
        x, y = local(c["lon"], c["lat"], g)
        if 0 < x < g["width_m"] and 0 < y < g["height_m"]:
            hosp.append({"name": nm, "x": x, "y": y})
    seen = set(); hosp = [h for h in hosp if not (h["name"] in seen or seen.add(h["name"]))]

    ev = {"t0": T0.isoformat(), "time_step_min": 6, "gauges": gauges,
          "sandy": {"start_min": grid_t[0], "step_min": 6, "levels": sandy,
                    "window": {"start": (T0 + dt.timedelta(minutes=start)).isoformat(), "end": (T0 + dt.timedelta(minutes=end)).isoformat()}},
          "tide_speeds_deg_per_h": SPEEDS, "hwm": hwms(g, boro20), "atlas14": atlas14(), "vulnerability": fv_tables(),
          "subway": stations, "hospitals": hosp,
          "labels": {"boroughs": [{"name": n, "x": local(lo, la, g)[0], "y": local(lo, la, g)[1]} for n, la, lo in BOROUGH_LABELS],
                     "landmarks": [{"name": n, "x": local(lo, la, g)[0], "y": local(lo, la, g)[1]} for n, la, lo in LANDMARKS]}}
    json.dump(ev, open(os.path.join(WEB, "events.json"), "w"), separators=(",", ":"))
    print(f"HWMs {len(ev['hwm'])} (in NYC {sum(1 for h in ev['hwm'] if h['boro'])}); stations {len(stations)}; hospitals {len(hosp)};"
          f" size {os.path.getsize(os.path.join(WEB, 'events.json')) / 1e3:.0f} KB")
    a = ev["atlas14"]
    print("Atlas 14 Central Park, 60 min (mm):", dict(zip(a["return_periods_yr"], a["depth"][4])))


if __name__ == "__main__":
    main()
