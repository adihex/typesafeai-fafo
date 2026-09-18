#!/usr/bin/env python3
# row.py <transcript> <runtime> <case> <arm> <run> <exit> <score> <secs> <graders-json>
# Merge metrics extraction with run metadata into one results.jsonl row.
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from metrics import extract

transcript, rt, case, arm, run, exit_c, score, secs, graders = sys.argv[1:10]
m = extract(transcript)
m.update(
    runtime=rt, case=case, arm=arm, run=int(run), exit=int(exit_c),
    score=float(score), secs=int(secs), graders=json.loads(graders),
)
print(json.dumps(m))
