# omp.sh — omp (oh-my-pi) adapter.
# Surfaces: skills = ~/.omp/skills/<name>/ (best-guess; omp has --no-skills so it
#   discovers skills somewhere); MCP = ~/.omp/mcp.json (best-guess)
# Auth: ~/.omp/agent/ state (per-file symlinks)
FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() {
  local h; h=$(mktemp -d)
  mkdir -p "$h/.omp/skills"
  for d in agent profiles install-id; do
    ln -s "$REAL_HOME/.omp/$d" "$h/.omp/" 2>/dev/null
  done
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.omp/skills/fafo-resolve"
    cat > "$h/.omp/mcp.json" <<CFG
{"mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
CFG
  fi
  echo "$h"
}

rt_invoke() {
  (
    cd "$2" || exit 1
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" omp launch \
      -p --auto-approve \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
