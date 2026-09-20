# claude.sh — Claude Code adapter (claude-personal).
# Surfaces: skills = ~/.claude/skills/<name>/SKILL.md; MCP = "mcpServers" in ~/.claude.json
# Auth: macOS Keychain (HOME-independent) + ~/.claude/ state — fake HOME just works.
# NOTE: subject to the plan's 5h usage window — quota-exhausted runs exit nonzero
# and score 0; re-run the suite when the window resets.

FAFO_REPO="${FAFO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"  # self-locating: the checkout hosting evals/ also hosts the surfaces under test
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() { # <with|without> <fixture-cwd> ($2 unused — no trust gate)
  local h; h=$(mktemp -d)
  mkdir -p "$h/.claude/skills"
  if [ "$1" = "with" ]; then
    cp -r "$FAFO_SKILL" "$h/.claude/skills/fafo-resolve"
    cat > "$h/.claude.json" <<EOF
{"mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
EOF
  else
    : > "$h/.claude.json"
  fi
  echo "$h"
}

rt_invoke() { # <prompt-file> <cwd> <transcript-out> <home>
  (
    cd "$2" || exit 1
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" claude -p \
      --output-format json \
      --dangerously-skip-permissions \
      "$(cat "$1")" >"$3" 2>"$3.stderr"
  )
}
