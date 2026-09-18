# droid.sh — Factory droid adapter.
# Surfaces: skills = ~/.factory/skills/<name>/; MCP = ~/.factory/mcp.json
# Auth: keychain (auth.v2.loginkeychain) + ~/.factory/settings.json symlink
FAFO_REPO="${FAFO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"  # self-locating: the checkout hosting evals/ also hosts the surfaces under test
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.factory/skills"
  for f in settings.json auth.v2.loginkeychain cli-hints.json; do
    ln -s "$REAL_HOME/.factory/$f" "$h/.factory/" 2>/dev/null
  done
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.factory/skills/fafo-resolve"
    cat > "$h/.factory/mcp.json" <<CFG
{"mcpServers":{"fafo":{"type":"stdio","command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"],"disabled":false}}}
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" PATH="$REAL_HOME/.local/bin:$REAL_HOME/bin:$PATH" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" droid exec \
      --skip-permissions-unsafe -o stream-json \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
