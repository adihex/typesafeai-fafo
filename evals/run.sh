#!/usr/bin/env bash
# run.sh [case ...] — eval driver.
#   RUNS=N        runs per case per arm (default 3; a single run is noise)
#   ARMS="with without"   which arms (default both)
#   DEADLINE=600  per-run seconds before kill
set -uo pipefail
cd "$(dirname "$0")/.."
RUNS=${RUNS:-3}
ARMS=${ARMS:-"with without"}
DEADLINE=${DEADLINE:-600}
REAL_HOME="$HOME"
OUT=evals/results/$(date -u +%Y-%m-%dT%H-%M-%S)
mkdir -p "$OUT"
CASES=("$@")
[ ${#CASES[@]} -eq 0 ] && CASES=($(ls evals/cases))
RESULTS="$OUT/results.jsonl"; : > "$RESULTS"

# Baseline HOME: auth + config survive; skills dir and mcp_config.json don't.
fakehome() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.local/share/devin" "$h/.config/devin"
  ln -s "$REAL_HOME/.local/share/devin/credentials.toml" "$h/.local/share/devin/" 2>/dev/null
  ln -s "$REAL_HOME/.local/share/devin/cli" "$h/.local/share/devin/" 2>/dev/null
  cp "$REAL_HOME/.config/devin/config.json" "$h/.config/devin/" 2>/dev/null
  echo "$h"
}

# devin -p with a kill deadline (no GNU timeout on macOS).
run_agent() { # <prompt-file> <cwd> <transcript-out> <home>
  local prompt_file="$1" cwd="$2" out="$3" fake="$4"
  (
    cd "$cwd" || exit 1
    HOME="$fake" devin -p \
      --export "$out" \
      --permission-mode dangerous --sandbox \
      -- "$(cat "$prompt_file")" >"$out.stdout" 2>"$out.stderr"
  ) &
  local pid=$! waited=0
  while kill -0 $pid 2>/dev/null; do
    sleep 5; waited=$((waited+5))
    if [ $waited -ge "$DEADLINE" ]; then kill -9 $pid 2>/dev/null; wait $pid 2>/dev/null; return 124; fi
  done
  wait $pid
}

echo "evals → $OUT  (runs=$RUNS arms=[$ARMS] deadline=${DEADLINE}s)"
for case in "${CASES[@]}"; do
  dir="evals/cases/$case"
  [ -f "$dir/prompt.md" ] || { echo "skip $case — no prompt.md"; continue; }
  fixture_kind=$(sed -n 's/^fixture: *//p' "$dir/case.yaml" 2>/dev/null | head -1)
  fixture_kind=${fixture_kind:-clean}
  for arm in $ARMS; do
    for run in $(seq 1 "$RUNS"); do
      scratch=$(mktemp -d); transcript="$OUT/${case}.${arm}.r${run}.json"
      evals/lib/mkfixture.sh "$fixture_kind" "$scratch" || { echo "$case/$arm/r$run FIXTURE-FAIL"; continue; }
      home="$REAL_HOME"
      [ "$arm" = "without" ] && home=$(fakehome)
      t0=$(date +%s)
      run_agent "$dir/prompt.md" "$scratch" "$transcript" "$home"
      code=$?
      score_json=$(evals/lib/grade.py "$dir" "$scratch" "$transcript" "$code" 2>/dev/null)
      score=$(echo "$score_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['score'])" 2>/dev/null || echo 0)
      echo "{\"case\":\"$case\",\"arm\":\"$arm\",\"run\":$run,\"exit\":$code,\"score\":$score,\"secs\":$(( $(date +%s)-t0 )),\"graders\":$(echo "$score_json" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['graders']))" 2>/dev/null || echo '[]')}" >> "$RESULTS"
      echo "  $case [$arm] r$run → score=$score exit=$code"
      rm -rf "$scratch"
      [ "$arm" = "without" ] && rm -rf "$home"
    done
  done
done
evals/lib/report.py "$RESULTS"
echo "results: $RESULTS"
