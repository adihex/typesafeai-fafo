# codex.sh — OpenAI codex CLI adapter.
# Surfaces: skills = ~/.codex/skills/<name>/; MCP = [mcp_servers.*] in config.toml
# Auth: ~/.codex/auth.json
FAFO_REPO="${FAFO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"  # self-locating: the checkout hosting evals/ also hosts the surfaces under test
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.codex/skills" "$h/.local/bin"
  # ~/bin/codex is a $HOME-relative shim -> exec $HOME/.local/bin/codex
  ln -s "$REAL_HOME/.local/bin/codex" "$h/.local/bin/codex"
  ln -s "$REAL_HOME/.codex/auth.json" "$h/.codex/" 2>/dev/null
  ln -s "$REAL_HOME/.codex/packages" "$h/.codex/" 2>/dev/null
  # carry the real config in both arms (model pin, trusts) — strip any fafo
  # block, then re-add ours in the WITH arm so the arm boundary holds
  awk '/^\[mcp_servers\.fafo\]/ {skip=1; next} /^\[/ {skip=0} !skip' \
      "$REAL_HOME/.codex/config.toml" > "$h/.codex/config.toml" 2>/dev/null
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.codex/skills/fafo-resolve"
    cat >> "$h/.codex/config.toml" <<CFG

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
    HOME="$4" PATH="$REAL_HOME/.local/bin:$REAL_HOME/bin:$PATH" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" codex exec \
      --dangerously-bypass-approvals-and-sandbox --json \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
