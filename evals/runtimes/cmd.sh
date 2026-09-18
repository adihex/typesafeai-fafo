# cmd.sh — cmd CLI adapter.
# Surfaces: skills = ~/.cmd/skills/<name>/ (+ --skill flag); MCP = settings.json mcpServers
# Auth: ~/.cmd/settings.json
FAFO_REPO="${FAFO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"  # self-locating: the checkout hosting evals/ also hosts the surfaces under test
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.cmd/skills"
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.cmd/skills/fafo-resolve"
    cat > "$h/.cmd/settings.json" <<CFG
{"mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
CFG
  else
    # real settings.json is a lone fafo MCP block -> WITHOUT arm must not carry it
    echo '{}' > "$h/.cmd/settings.json"
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" PATH="$REAL_HOME/.local/bin:$REAL_HOME/bin:$PATH" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" cmd \
      -p -t --tools-all \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
