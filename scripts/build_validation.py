"""Collect the reference Sandy runs (tests/run_scenario.py at 80, 40 and 20 m) into
web/data/validation.json for the Validation tab and the methodology page."""
from __future__ import annotations

import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PROC = os.path.join(ROOT, "data", "processed")


def main():
    runs = []
    for dx in (80, 40, 20):
        p = os.path.join(PROC, f"run_sandy_{dx}m.json")
        if not os.path.exists(p):
            continue
        r = json.load(open(p))
        hw = [h for h in r["hwm"] if h["sim"] is not None]
        nyc = [h["sim"] - h["obs"] for h in hw if h.get("boro")]
        stat = lambda a: {"n": len(a), "bias": round(sum(a) / len(a), 3), "mae": round(sum(abs(x) for x in a) / len(a), 3),  # noqa: E731
                          "rmse": round((sum(x * x for x in a) / len(a)) ** 0.5, 3)}
        e = r["extent"]
        runs.append({
            "dx": dx, "cells": r["cells"], "steps": r["steps"],
            "hwm": {**r["hwmStats"], "dry": r["hwmDry"], "total": len(r["hwm"])},
            "hwm_nyc": stat(nyc),
            "extent": {"csi": e["csi"], "hitRate": e["hitRate"], "far": e["falseAlarmRatio"], "obsKm2": e["observedKm2"], "simKm2": e["simulatedKm2"]},
            "impact": r["impact"],
            "marks": [[h["id"], h["obs"], h["sim"], h.get("boro") or 0] for h in r["hwm"]],
        })
    out = {"event": "Hurricane Sandy, 29 to 30 October 2012", "source": "tests/run_scenario.py, full 12-hour replay", "runs": runs}
    json.dump(out, open(os.path.join(ROOT, "web", "data", "validation.json"), "w"), separators=(",", ":"))
    for r in runs:
        print(r["dx"], r["hwm"], r["hwm_nyc"], r["extent"], round(r["impact"]["loss"] / 1e9, 2))


if __name__ == "__main__":
    main()
