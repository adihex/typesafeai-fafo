#!/usr/bin/env python3
# grade.py <case_dir> <fixture_dir> <transcript> <exit_code>
# Graders file: one per line — `kind | arg | pattern` (delimiter = " | ").
# Prefix `orN:` to OR-group graders — group passes if any member passes.
# Kinds: transcript_contains, transcript_lacks (pattern over transcript);
#        file_contains, file_lacks (arg=relpath, pattern over file);
#        exit_code (arg=expected). Prints JSON to stdout.
import json
import re
import sys
from pathlib import Path

case_dir, fixture_dir, transcript_path, exit_code = (
    Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4],
)

transcript = transcript_path.read_text(errors="replace") if transcript_path.exists() else ""

def check(kind, arg, pattern):
    if kind == "transcript_contains":
        return bool(re.search(pattern, transcript, re.I | re.S))
    if kind == "transcript_lacks":
        return not re.search(pattern, transcript, re.I | re.S)
    if kind == "exit_code":
        return int(arg) == int(exit_code)
    if kind in ("file_contains", "file_lacks"):
        f = fixture_dir / arg
        text = f.read_text(errors="replace") if f.exists() else ""
        found = bool(re.search(pattern, text))
        return found if kind == "file_contains" else not found
    return False

singles, groups = [], {}
for line in (case_dir / "graders").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    group = None
    m = re.match(r"^(or\w+):\s*(.*)$", line)
    if m:
        group, line = m.group(1), m.group(2)
    parts = [p.strip() for p in line.split(" | ")]
    kind = parts[0]
    arg = parts[1] if kind in ("file_contains", "file_lacks", "exit_code") else ""
    pattern = parts[-1]
    item = {"kind": kind, "arg": arg, "pattern": pattern, "pass": check(kind, arg, pattern)}
    (groups.setdefault(group, []) if group else singles).append(item)

results = singles + [
    {"kind": f"OR({g})", "arg": "", "pattern": "", "pass": any(i["pass"] for i in items)}
    for g, items in sorted(groups.items())
]
score = sum(1 for r in results if r["pass"]) / max(len(results), 1)
print(json.dumps({"score": score, "graders": results}))
