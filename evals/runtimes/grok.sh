# grok.sh — grok CLI adapter.
# Surfaces: no skill convention found (~/.grok has none) — MCP only.
#   MCP = ~/.grok/config.toml [mcp_servers.*] (codex-style, best-guess)
# Auth: ~/.grok/auth.json
# NOTE: the real config.toml already carries [mcp_servers.fafo] (main-repo
# path) — strip it in both arms, re-add ours in WITH so the arm boundary holds.
FAFO_REPO="${FAFO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"  # self-locating: the checkout hosting evals/ also hosts the surfaces under test

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.grok"
  ln -s "$REAL_HOME/.grok/auth.json" "$h/.grok/" 2>/dev/null
  # copy real config minus any existing fafo MCP block (drop section header +
  # its keys until the next [section])
  awk '/^\[mcp_servers\.fafo\]/ {skip=1; next} /^\[/ {skip=0} !skip' \
      "$REAL_HOME/.grok/config.toml" > "$h/.grok/config.toml" 2>/dev/null
  if [ "$1" = "with" ]; then
    cat >> "$h/.grok/config.toml" <<CFG

[mcp_servers.fafo]
command = "npx"
args = ["tsx", "$FAFO_REPO/packages/cli/src/cli.ts", "mcp"]
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" PATH="$REAL_HOME/.local/bin:$REAL_HOME/bin:$PATH" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" grok --single "$(cat "$1")" \
      --always-approve --output-format streaming-json >"$3" 2>"$3.stderr"
  )
}
