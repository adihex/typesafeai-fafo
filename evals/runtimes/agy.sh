# agy.sh — agy (antigravity CLI) adapter.
# Surfaces: skills = ~/.gemini/antigravity/skills/<name>/;
#   MCP = ~/.gemini/config/mcp_config.json {"mcpServers":{...}}
# Auth: ~/.gemini state (oauth creds live under ~/.gemini/antigravity/)
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.gemini/antigravity/skills" "$h/.gemini/config"
  # auth/state bits — symlink the antigravity state tree wholesale except skills
  for d in brain cli.log implicit knowledge installation_id antigravity_state.pbtxt; do
    ln -s "$REAL_HOME/.gemini/antigravity/$d" "$h/.gemini/antigravity/" 2>/dev/null
  done
  ln -s "$REAL_HOME/.gemini/settings.json" "$h/.gemini/" 2>/dev/null
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.gemini/antigravity/skills/fafo-resolve"
    cat > "$h/.gemini/config/mcp_config.json" <<CFG
{"mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
CFG
  else
    ln -s "$REAL_HOME/.gemini/config/mcp_config.json" "$h/.gemini/config/" 2>/dev/null
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" agy \
      --print --dangerously-skip-permissions \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
