#!/usr/bin/env python3
# report.py <results.jsonl> — A/B table per runtime: correctness, wall time,
# agent tokens, steps, tool calls, skill-fire rate, Jev tokens.
# WITH vs WITHOUT side by side plus Δ on the primary metric (score).
import json
import statistics
import sys
from collections import defaultdict

rows = defaultdict(lambda: defaultdict(list))
for line in open(sys.argv[1]):
    r = json.loads(line)
    rows[(r.get("runtime", "?"), r["case"])][r["arm"]].append(r)


def mean(rs, key):
    vals = [r[key] for r in rs if isinstance(r.get(key), (int, float))]
    return statistics.mean(vals) if vals else None


def fmt(v, w=7, pct=False):
    if v is None:
        return f"{'—':>{w}}"
    return f"{v:>{w}.0%}" if pct else f"{v:>{w}.1f}"


def file_ok(rs):
    """Fraction of file-state graders (contains/lacks) that passed —
    correctness of the end state, independent of which tools were used."""
    tot = ok = 0
    for r in rs:
        for g in r.get("graders") or []:
            if g.get("kind") in ("file_contains", "file_lacks"):
                tot += 1
                ok += g["pass"]
    return ok / tot if tot else None


def surf_rate(rs):
    """How often the agent invoked the fafo surface (skill or MCP tools)."""
    hits = sum(
        1
        for r in rs
        if r.get("skill_fired")
        or (r.get("tool_fns") or {}).get("mcp_call_tool")
        or any(
            "fafo" in (g.get("pattern") or "") and g["pass"]
            for g in r.get("graders") or []
            if g.get("kind") == "transcript_contains"
        )
    )
    return hits / len(rs) if rs else None


COLS = [
    ("score", lambda rs: mean(rs, "score"), "{:.2f}"),
    ("fileOK", file_ok, "{:.0%}"),
    ("surf", surf_rate, "{:.0%}"),
    ("secs", lambda rs: mean(rs, "secs"), "{:.0f}"),
    ("steps", lambda rs: mean(rs, "agent_steps"), "{:.0f}"),
    ("tools", lambda rs: mean(rs, "tool_calls"), "{:.0f}"),
    ("promptK", lambda rs: (mean(rs, "agent_prompt_tokens") or 0) / 1000, "{:.0f}"),
    ("compl", lambda rs: mean(rs, "agent_completion_tokens"), "{:.0f}"),
    ("jevK", lambda rs: ((mean(rs, "jev_input_tokens") or 0)
                          + (mean(rs, "jev_output_tokens") or 0)) / 1000, "{:.1f}"),
]

rts = sorted({rt for rt, _ in rows})
for rt in rts:
    cases = sorted(c for r, c in rows if r == rt)
    print(f"\n== {rt} ==  (n per cell in parens)\n")
    hdr = f"{'CASE':<26} │"
    print(hdr + "  ".join(f"{name:>7}" for name, _, _ in COLS[:5])
          + " │ " + "  ".join(f"{name:>7}" for name, _, _ in COLS[5:]))
    deltas = []
    for case in cases:
        arms = rows[(rt, case)]
        w, wo = arms.get("with", []), arms.get("without", [])
        for label, rs in (("with", w), ("without", wo)):
            if not rs:
                continue
            cells = [f.format(fx(rs)) if fx(rs) is not None else "—"
                     for _, fx, f in [(n, fn, f) for n, fn, f in COLS]]
            print(f"{case + ' ' + label:<26} │ " + "  ".join(f"{c:>7}" for c in cells)
                  + f"  (n={len(rs)})")
        if w and wo:
            d = (mean(w, "score") or 0) - (mean(wo, "score") or 0)
            deltas.append(d)
            print(f"{case + ' Δscore':<26} │ {d:>+7.2f}")
    if deltas:
        print(f"\n  mean Δscore (with − without): {sum(deltas)/len(deltas):+.2f}")
print()
