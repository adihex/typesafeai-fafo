# cursor-agent.sh — Cursor agent CLI adapter.
# Surfaces: skills = ~/.cursor/skills/<name>/; MCP = ~/.cursor/mcp-config.json
# Auth: ~/.cursor/cli-config.json + agent-cli-state.json (per-file symlinks)
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.cursor/skills"
  for f in cli-config.json agent-cli-state.json acp-config.json argv.json; do
    ln -s "$REAL_HOME/.cursor/$f" "$h/.cursor/" 2>/dev/null
  done
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.cursor/skills/fafo-resolve"
    cat > "$h/.cursor/mcp-config.json" <<CFG
{"mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" cursor-agent \
      -p --output-format text --force --approve-mcps \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
