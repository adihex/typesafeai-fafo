#!/usr/bin/env bash
# run.sh [case ...] — agent-surface eval driver, runtime-pluggable.
#   RUNTIMES="devin claude ..."  adapters in evals/runtimes/ (default: devin)
#   RUNS=N        runs per case per arm (default 3; a single run is noise)
#   ARMS="with without"   ablation arms (default both)
#   DEADLINE=600  per-run seconds before kill
set -uo pipefail
cd "$(dirname "$0")/.."
RUNS=${RUNS:-3}
ARMS=${ARMS:-"with without"}
RUNTIMES=${RUNTIMES:-devin}
DEADLINE=${DEADLINE:-600}
REAL_HOME="$HOME"
OUT=evals/results/$(date -u +%Y-%m-%dT%H-%M-%S)
mkdir -p "$OUT"
CASES=("$@")
[ ${#CASES[@]} -eq 0 ] && CASES=($(ls evals/cases))
RESULTS="$OUT/results.jsonl"; : > "$RESULTS"

run_with_deadline() { # <cmd-or-func> [args...] — kill after DEADLINE (no GNU timeout on macOS)
  ( "$@" ) &
  local pid=$! waited=0
  while kill -0 $pid 2>/dev/null; do
    sleep 5; waited=$((waited+5))
    if [ $waited -ge "$DEADLINE" ]; then kill -9 $pid 2>/dev/null; wait $pid 2>/dev/null; return 124; fi
  done
  wait $pid
}

echo "evals → $OUT  (runtimes: $RUNTIMES | runs=$RUNS arms: $ARMS | deadline=${DEADLINE}s)"
for rt in $RUNTIMES; do
  adapter="evals/runtimes/$rt.sh"
  [ -f "$adapter" ] || { echo "== $rt: no adapter (evals/runtimes/$rt.sh missing)"; continue; }
  source "$adapter"
  echo "== runtime: $rt"
  for case in "${CASES[@]}"; do
    dir="evals/cases/$case"
    [ -f "$dir/prompt.md" ] || { echo "  skip $case — no prompt.md"; continue; }
    fixture_kind=$(sed -n 's/^fixture: *//p' "$dir/case.yaml" 2>/dev/null | head -1)
    fixture_kind=${fixture_kind:-clean}
    for arm in $ARMS; do
      for run in $(seq 1 "$RUNS"); do
        scratch=$(mktemp -d); transcript="$OUT/${rt}.${case}.${arm}.r${run}.json"
        evals/lib/mkfixture.sh "$fixture_kind" "$scratch" || { echo "  $case/$arm/r$run FIXTURE-FAIL"; continue; }
        home=$(rt_fake_home "$arm") || { echo "  $case/$arm/r$run HOME-FAIL"; continue; }
        t0=$(date +%s)
        run_with_deadline rt_invoke "$dir/prompt.md" "$scratch" "$transcript" "$home"
        code=$?
        score_json=$(evals/lib/grade.py "$dir" "$scratch" "$transcript" "$code" 2>/dev/null)
        score=$(echo "$score_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['score'])" 2>/dev/null || echo 0)
        graders=$(echo "$score_json" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['graders']))" 2>/dev/null || echo '[]')
        echo "{\"runtime\":\"$rt\",\"case\":\"$case\",\"arm\":\"$arm\",\"run\":$run,\"exit\":$code,\"score\":$score,\"secs\":$(( $(date +%s)-t0 )),\"graders\":$graders}" >> "$RESULTS"
        echo "  $case [$arm] r$run → score=$score exit=$code"
        rm -rf "$scratch" "$home"
      done
    done
  done
done
evals/lib/report.py "$RESULTS"
echo "results: $RESULTS"
