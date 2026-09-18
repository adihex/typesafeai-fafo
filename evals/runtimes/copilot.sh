# copilot.sh — GitHub copilot CLI adapter.
# Surfaces: skills = ~/.copilot/skills/<name>/; MCP = ~/.copilot/mcp-config.json
# Auth: ~/.config/github-copilot/ (auth.db) + ~/.copilot/config.json
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.copilot/skills" "$h/.config"
  ln -s "$REAL_HOME/.config/github-copilot" "$h/.config/" 2>/dev/null
  for f in config.json copilot-instructions.md data.db; do
    ln -s "$REAL_HOME/.copilot/$f" "$h/.copilot/" 2>/dev/null
  done
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.copilot/skills/fafo-resolve"
    cat > "$h/.copilot/mcp-config.json" <<CFG
{"mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"],"tools":["*"]}}}
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" copilot \
      -p "$(cat "$1")" --allow-all-tools >"$3" 2>"$3.stderr"
  )
}
