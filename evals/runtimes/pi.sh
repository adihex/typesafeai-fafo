# pi.sh — pi agent adapter.
# Surfaces: skills = ~/.pi/agent/skills/<name>/ (best-guess); MCP = ~/.pi/agent/mcp.json (best-guess)
# Auth: ~/.pi/agent/auth.json
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.pi/agent/skills"
  for f in auth.json agent.db AGENTS.md; do
    ln -s "$REAL_HOME/.pi/agent/$f" "$h/.pi/agent/" 2>/dev/null
  done
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
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" pi \
      -p "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
