#!/usr/bin/env python3
# report.py <results.jsonl> — WITH/W/OUT/Δ table, plugin-eval style.
import json
import sys
from collections import defaultdict

rows = defaultdict(lambda: defaultdict(list))
for line in open(sys.argv[1]):
    r = json.loads(line)
    rows[r["case"]][r["arm"]].append(r["score"])

print(f"\n{'CASE':<28} {'WITH':>5} {'W/OUT':>6} {'Δ':>6}  RUNS")
deltas = []
for case in sorted(rows):
    w = rows[case].get("with", [])
    wo = rows[case].get("without", [])
    mw = sum(w) / len(w) if w else 0
    mwo = sum(wo) / len(wo) if wo else 0
    d = mw - mwo
    if w and wo:
        deltas.append(d)
        print(f"{case:<28} {mw:>5.2f} {mwo:>6.2f} {d:>+6.2f}  {len(w)+len(wo)}")
    else:
        arm = "with" if w else "without"
        print(f"{case:<28} {mw if w else mwo:>5.2f} {'—':>6} {'—':>6}  {len(w) or len(wo)} ({arm} only)")
if deltas:
    print(f"\n{len(rows)} case(s) · mean Δ {sum(deltas)/len(deltas):+.2f}")
