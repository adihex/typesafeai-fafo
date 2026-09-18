# grok.sh — grok CLI adapter.
# Surfaces: no skill convention found (~/.grok has none) — MCP only.
#   MCP = ~/.grok/config.toml [mcp_servers.*] (codex-style, best-guess)
# Auth: ~/.grok/auth.json
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.grok"
  ln -s "$REAL_HOME/.grok/auth.json" "$h/.grok/" 2>/dev/null
  ln -s "$REAL_HOME/.grok/config.toml" "$h/.grok/" 2>/dev/null
  if [ "$1" = "with" ]; then
    cat > "$h/.grok/config.toml" <<CFG
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
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" grok agent \
      --auto-approve \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
