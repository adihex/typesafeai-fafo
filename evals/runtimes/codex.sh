# codex.sh — OpenAI codex CLI adapter.
# Surfaces: skills = ~/.codex/skills/<name>/; MCP = [mcp_servers.*] in config.toml
# Auth: ~/.codex/auth.json
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.codex/skills"
  ln -s "$REAL_HOME/.codex/auth.json" "$h/.codex/" 2>/dev/null
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.codex/skills/fafo-resolve"
    cat > "$h/.codex/config.toml" <<CFG
[mcp_servers.fafo]
command = "npx"
args = ["tsx", "$FAFO_REPO/packages/cli/src/cli.ts", "mcp"]
CFG
  else
    ln -s "$REAL_HOME/.codex/config.toml" "$h/.codex/" 2>/dev/null
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" codex exec \
      --dangerously-bypass-approvals-and-sandbox \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
