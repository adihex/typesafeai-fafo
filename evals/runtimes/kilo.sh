# kilo.sh — kilo CLI (opencode fork) adapter.
# Surfaces: skills = ~/.config/kilo/skills/<name>/; MCP = "mcp" in kilo.jsonc
# Auth: ~/.local/share/kilo/auth.json (opencode convention)
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.config/kilo/skills" "$h/.local/share/kilo" "$h/.kilo"
  for d in kilo.db kilo.db-shm kilo.db-wal log repos snapshot storage telemetry-id; do
    ln -s "$REAL_HOME/.local/share/kilo/$d" "$h/.local/share/kilo/" 2>/dev/null
  done
  ln -s "$REAL_HOME/.kilo/bin" "$h/.kilo/" 2>/dev/null
  ln -s "$REAL_HOME/.config/kilo/kilo.jsonc" "$h/.config/kilo/" 2>/dev/null
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.config/kilo/skills/fafo-resolve"
    cat > "$h/.config/kilo/kilo.jsonc" <<CFG
{"mcp":{"fafo":{"type":"local","command":["npx","tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"],"enabled":true}}}
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" PATH="$REAL_HOME/.local/bin:$REAL_HOME/bin:$PATH" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" kilo run \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
