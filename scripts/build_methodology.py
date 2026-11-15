"""Fill the validation table and figures of web/methodology.html from web/data/validation.json.
The page text lives in scripts/methodology.template.html; this script writes web/methodology.html."""
from __future__ import annotations

import json
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
WEB = os.path.join(ROOT, "web")


def main():
    V = json.load(open(os.path.join(WEB, "data", "validation.json")))
    runs = V["runs"]
    rows = "".join(
        f'<tr><td>{r["dx"]} m</td><td class="num">{r["cells"]:,}</td><td class="num">{r["hwm"]["n"]} of {r["hwm"]["total"]}</td>'
        f'<td class="num">{r["hwm"]["bias"]:+.2f}</td><td class="num">{r["hwm"]["mae"]:.2f}</td><td class="num">{r["hwm"]["rmse"]:.2f}</td>'
        f'<td class="num">{r["hwm_nyc"]["mae"]:.2f}</td><td class="num">{r["extent"]["csi"]:.2f}</td><td class="num">{r["extent"]["hitRate"]:.2f}</td>'
        f'<td class="num">{r["extent"]["far"]:.2f}</td><td class="num">${r["impact"]["loss"] / 1e9:.1f}B</td></tr>' for r in runs)
    r = next(x for x in runs if x["dx"] == 40)
    b = r["impact"]["lossByBorough"]
    subs = {
        "{{ROWS}}": rows,
        "{{N40}}": str(r["hwm"]["n"]), "{{TOTAL}}": str(r["hwm"]["total"]), "{{BIAS40}}": f'{r["hwm"]["bias"]:+.2f}',
        "{{NNYC}}": str(r["hwm_nyc"]["n"]), "{{MAENYC}}": f'{r["hwm_nyc"]["mae"]:.2f}', "{{CSI40}}": f'{r["extent"]["csi"]:.2f}',
        "{{LOSS40}}": f'{r["impact"]["loss"] / 1e9:.1f}', "{{BK}}": f"{b[3] / 1e9:.1f}", "{{QN}}": f"{b[4] / 1e9:.1f}",
        "{{MN}}": f"{b[1] / 1e9:.1f}", "{{SI}}": f"{b[5] / 1e9:.1f}", "{{BX}}": f"{b[2] / 1e9:.1f}",
    }
    s = open(os.path.join(ROOT, "scripts", "methodology.template.html"), encoding="utf-8").read()
    for k, v in subs.items():
        s = s.replace(k, v)
    assert "{{" not in s, "unfilled placeholder"
    open(os.path.join(WEB, "methodology.html"), "w", encoding="utf-8").write(s)
    print("methodology.html written,", len(s), "bytes")


if __name__ == "__main__":
    main()
