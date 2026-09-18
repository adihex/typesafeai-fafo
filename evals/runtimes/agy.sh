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
  ln -s "$REAL_HOME/.gemini/antigravity-cli" "$h/.gemini/" 2>/dev/null
  ln -s "$REAL_HOME/.gemini/jetski-standalone-oauth-token" "$h/.gemini/" 2>/dev/null
  for f in settings.json oauth_creds.json google_accounts.json projects.json state.json; do
    ln -s "$REAL_HOME/.gemini/$f" "$h/.gemini/" 2>/dev/null
  done
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
    HOME="$4" PATH="$REAL_HOME/.local/bin:$REAL_HOME/bin:$PATH" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" agy \
      --dangerously-skip-permissions \
      --print="$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
