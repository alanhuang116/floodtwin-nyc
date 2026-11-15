"""Run a scenario headlessly on the GPU and report validation numbers.

    python tests/run_scenario.py sandy 40 [extra query, e.g. "&porosity=0"]
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from browser import run_page  # noqa: E402


def main():
    preset = sys.argv[1] if len(sys.argv) > 1 else "sandy"
    dx = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    extra = sys.argv[3] if len(sys.argv) > 3 else ""
    r = run_page(f"tests/run_scenario.html?preset={preset}&dx={dx}{extra}", budget_ms=1800000, timeout=3600,
                 extra_flags=("--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist"))
    if not r.get("ok"):
        raise SystemExit("run failed: " + r.get("error", "?"))
    print(f"{r['preset']} at {r['dx']} m ({r['nx']} x {r['ny']} = {r['cells']:,} cells): {r['steps']:,} steps, "
          f"{r['simSeconds'] / 3600:.1f} h; lowest coast {r['minCoastZ']:.2f} m")
    for t, st, wet, vol in r["series"]:
        print(f"   t={t / 3600:5.2f} h  Battery {st:6.3f} m  flooded in NYC {wet / 1e6:7.2f} km2  volume {vol / 1e6:7.2f} hm3")
    print("   HWM", r["hwmStats"], "dry", r["hwmDry"])
    print("   extent", r["extent"])
    print("   impact", r["impact"])
    tag = extra.replace("&", "_").replace("=", "") if extra else ""
    json.dump(r, open(os.path.join(HERE, "..", "data", "processed", f"run_{preset}_{dx}m{tag}.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
