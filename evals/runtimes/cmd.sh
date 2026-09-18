# cmd.sh — cmd CLI adapter.
# Surfaces: skills = ~/.cmd/skills/<name>/ (+ --skill flag); MCP = settings.json mcpServers
# Auth: ~/.cmd/settings.json
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.cmd/skills"
  ln -s "$REAL_HOME/.cmd/settings.json" "$h/.cmd/" 2>/dev/null
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.cmd/skills/fafo-resolve"
    cat > "$h/.cmd/settings.json" <<CFG
{"mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" cmd \
      -p -t --tools-all \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
