# devin.sh — devin CLI adapter. Contract: defines rt_fake_home + rt_invoke.
# Surfaces: skills = ~/.agents/skills/<name>/SKILL.md; MCP = ~/.config/devin/mcp_config.json
# Auth: ~/.local/share/devin/credentials.toml (+ cli/ versioned bins, mcp/ state)

FAFO_REPO="${FAFO_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"  # self-locating: the checkout hosting evals/ also hosts the surfaces under test
FAFO_SKILL="${FAFO_SKILL:-$FAFO_REPO/skills/fafo-resolve}"

rt_fake_home() { # <with|without> <fixture-cwd> -> echo home path
  local h; h=$(mktemp -d)
  mkdir -p "$h/.local/share/devin/cli" "$h/.config/devin" "$h/.agents/skills"
  ln -s "$REAL_HOME/.local/share/devin/credentials.toml" "$h/.local/share/devin/" 2>/dev/null
  # link only the versioned runtime bins — NOT cli/ itself, whose
  # trusted_workspaces.json we must own (writing through a dir symlink
  # would clobber the real trust list)
  ln -s "$REAL_HOME/.local/share/devin/cli/_versions" "$h/.local/share/devin/cli/" 2>/dev/null
  cp "$REAL_HOME/.config/devin/config.json" "$h/.config/devin/" 2>/dev/null
  # headless runs can't answer the workspace-trust prompt — pre-trust the
  # fixture dir (and $TMPDIR parent for prefix-semantics safety)
  python3 - "$h/.local/share/devin/cli/trusted_workspaces.json" "$2" <<'PY'
import json, os, sys
out, cwd = sys.argv[1], os.path.realpath(sys.argv[2])
paths = {cwd, os.path.realpath(os.environ.get("TMPDIR", "/tmp"))}
json.dump({"trusted_paths": sorted(paths)}, open(out, "w"))
PY
  if [ "$1" = "with" ]; then
    cp -r "$FAFO_SKILL" "$h/.agents/skills/fafo-resolve"
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
      --sandbox \
      -- "$(cat "$1")" >"$3.stdout" 2>"$3.stderr"
  )
}
