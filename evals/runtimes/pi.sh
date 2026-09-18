# pi.sh — pi agent adapter.
# Surfaces: skills = ~/.pi/agent/skills/<name>/ (best-guess); MCP = ~/.pi/agent/mcp.json (best-guess)
# Auth: ~/.pi/agent/auth.json
FAFO_REPO="${FAFO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"  # self-locating: the checkout hosting evals/ also hosts the surfaces under test
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.pi/agent/skills"
  # ~/bin/pi shim execs node on $HOME/.bun/install/global/... — symlink bun tree
  ln -s "$REAL_HOME/.bun" "$h/.bun" 2>/dev/null
  mkdir -p "$h/bin" "$h/.local/share"
  ln -s "$REAL_HOME/bin/pi" "$h/bin/pi" 2>/dev/null
  ln -s "$REAL_HOME/.local/share/mise" "$h/.local/share/mise" 2>/dev/null
  for f in agent.db agent.db-shm agent.db-wal AGENTS.md mcp-onboarding.json mcp-cache.json mcp-npx-cache.json; do
    ln -s "$REAL_HOME/.pi/agent/$f" "$h/.pi/agent/" 2>/dev/null
  done
  cp "$REAL_HOME/.pi/agent/auth.json" "$h/.pi/agent/" 2>/dev/null
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.pi/agent/skills/fafo-resolve"
    cat > "$h/.pi/agent/mcp.json" <<CFG
{"mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" PATH="$REAL_HOME/.local/bin:$REAL_HOME/bin:$PATH" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" pi \
      -p --mode json --model openai-codex/gpt-5.6-luna "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
