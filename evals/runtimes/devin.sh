# devin.sh — devin CLI adapter. Contract: defines rt_fake_home + rt_invoke.
# Surfaces: skills = ~/.agents/skills/<name>/SKILL.md; MCP = ~/.config/devin/mcp_config.json
# Auth: ~/.local/share/devin/credentials.toml (+ cli/ versioned bins, mcp/ state)

FAFO_REPO="${FAFO_REPO:-/Users/adityabalakrishnan/Projects/typesafeai-fafo}"
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() { # <with|without> -> echo home path
  local h; h=$(mktemp -d)
  mkdir -p "$h/.local/share/devin" "$h/.config/devin" "$h/.agents/skills"
  ln -s "$REAL_HOME/.local/share/devin/credentials.toml" "$h/.local/share/devin/" 2>/dev/null
  ln -s "$REAL_HOME/.local/share/devin/cli" "$h/.local/share/devin/" 2>/dev/null
  cp "$REAL_HOME/.config/devin/config.json" "$h/.config/devin/" 2>/dev/null
  if [ "$1" = "with" ]; then
    ln -s "$FAFO_SKILL" "$h/.agents/skills/fafo-resolve"
    cat > "$h/.config/devin/mcp_config.json" <<EOF
{"mcpServers":{"fafo":{"command":"npx","args":["tsx","$FAFO_REPO/packages/cli/src/cli.ts","mcp"]}}}
EOF
  fi
  echo "$h"
}

rt_invoke() { # <prompt-file> <cwd> <transcript-out> <home>
  (
    cd "$2" || exit 1
    HOME="$4" TYPESAFE_API_KEY="${TYPESAFE_API_KEY:-}" devin -p \
      --export "$3" \
      --permission-mode dangerous --sandbox \
      -- "$(cat "$1")" >"$3.stdout" 2>"$3.stderr"
  )
}
