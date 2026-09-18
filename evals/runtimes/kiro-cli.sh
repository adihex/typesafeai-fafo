# kiro-cli.sh — Kiro CLI adapter.
# Surfaces: skills = ~/.kiro/skills/<name>/; MCP = mcpServers in ~/.kiro/agents/fafo-eval.json
#   (kiro scopes MCP per-agent — the `with` arm invokes --agent fafo-eval which
#   declares fafo; `without` uses default chat. Asymmetric but only path.)
# Auth: ~/.kiro/settings + sessions state (per-file symlinks)
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.kiro/skills" "$h/.kiro/agents"
  ln -s "$REAL_HOME/.aws" "$h/.aws" 2>/dev/null
  for d in settings sessions session-index argv.json; do
    ln -s "$REAL_HOME/.kiro/$d" "$h/.kiro/" 2>/dev/null
  done
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.kiro/skills/fafo-resolve"
    cat > "$h/.kiro/agents/fafo-eval.json" <<CFG
{"name":"fafo-eval","mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    local agent=""
    [ -f "$4/.kiro/agents/fafo-eval.json" ] && agent="--agent fafo-eval"
    HOME="$4" PATH="$REAL_HOME/.local/bin:$REAL_HOME/bin:$PATH" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" kiro-cli chat \
      $agent -a \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
