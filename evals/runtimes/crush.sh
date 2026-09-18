# crush.sh — crush (charm) adapter.
# Surfaces: no skill convention (crush has none) — MCP only.
#   MCP = "mcp" in ~/.config/crush/crush.json (charm format)
# Auth: ~/.local/share/crush/ + ~/.config/crush/crush.json
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.config/crush" "$h/.local/share"
  ln -s "$REAL_HOME/.local/share/crush" "$h/.local/share/" 2>/dev/null
  ln -s "$REAL_HOME/.config/crush/crush.json" "$h/.config/crush/" 2>/dev/null
  if [ "$1" = "with" ]; then
    cat > "$h/.config/crush/crush.json" <<CFG
{"mcp":{"fafo":{"type":"stdio","command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" crush run \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
