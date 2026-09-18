#!/usr/bin/env python3
# report.py <results.jsonl> — WITH/W/OUT/Δ table per runtime, plugin-eval style.
import json
import sys
from collections import defaultdict

rows = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
for line in open(sys.argv[1]):
    r = json.loads(line)
    rows[r.get("runtime", "?")][r["case"]][r["arm"]].append(r["score"])

for rt in sorted(rows):
    print(f"\n== {rt} ==\n{'CASE':<28} {'WITH':>5} {'W/OUT':>6} {'Δ':>6}  RUNS")
    deltas = []
    for case in sorted(rows[rt]):
        w = rows[rt][case].get("with", [])
        wo = rows[rt][case].get("without", [])
        mw = sum(w) / len(w) if w else 0
        mwo = sum(wo) / len(wo) if wo else 0
        n = len(w) + len(wo)
        if w and wo:
            deltas.append(mw - mwo)
            print(f"{case:<28} {mw:>5.2f} {mwo:>6.2f} {mw - mwo:>+6.2f}  {n}")
        else:
            print(f"{case:<28} {mw if w else mwo:>5.2f} {'—':>6} {'—':>6}  {n} (single arm)")
    if deltas:
        print(f"{'— mean Δ':<28} {'':>5} {'':>6} {sum(deltas)/len(deltas):>+6.2f}")
