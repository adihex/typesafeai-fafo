# omp.sh — omp (oh-my-pi) adapter.
# Surfaces: skills = ~/.omp/agent/skills/<name>/ (verified vs real dir);
#   MCP = ~/.omp/agent/mcp.json (pi-family convention, best-guess)
# Auth: ~/.omp/agent/ state (per-file symlinks — never symlink the dir itself
#   or the skill install would write into the real HOME)
FAFO_REPO="${FAFO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"  # self-locating: the checkout hosting evals/ also hosts the surfaces under test
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.omp/agent/skills"
  for f in agent.db agent.db-shm agent.db-wal config.yml models.yml models.db \
           models.db-shm models.db-wal last-changelog-version history.db \
           history.db-shm history.db-wal autoqa.db stats.db stats.db-shm \
           stats.db-wal commandcode-models.json; do
    ln -s "$REAL_HOME/.omp/agent/$f" "$h/.omp/agent/" 2>/dev/null
  done
  for d in blobs cache extensions sessions; do
    ln -s "$REAL_HOME/.omp/agent/$d" "$h/.omp/agent/" 2>/dev/null
  done
  # carry the real skill set in both arms (parity), add fafo-resolve in WITH
  for s in "$REAL_HOME"/.omp/agent/skills/*/; do
    ln -s "$s" "$h/.omp/agent/skills/" 2>/dev/null
  done
  for d in profiles install-id gpu_cache.json; do
    ln -s "$REAL_HOME/.omp/$d" "$h/.omp/" 2>/dev/null
  done
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.omp/agent/skills/fafo-resolve"
    cat > "$h/.omp/agent/mcp.json" <<CFG
{"mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" PATH="$REAL_HOME/.local/bin:$REAL_HOME/bin:$PATH" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" omp launch \
      -p --mode json --auto-approve \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
