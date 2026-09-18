#!/usr/bin/env bash
# provision.sh [home] — install fafo's agent surfaces into a HOME directory.
# Idempotent; merges MCP entries rather than overwriting existing config.
# Used by evals (fake HOMEs) and herdr workers (default: real $HOME).
set -euo pipefail

HOME_DIR="${1:-$HOME}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SKILL="$REPO/skills/fafo-resolve"
CLI="$REPO/packages/cli/src/cli.ts"

[ -f "$SKILL/SKILL.md" ] || { echo "no skill at $SKILL" >&2; exit 2; }

install_skill() { # <skills-dir>
  mkdir -p "$1"
  rm -rf "$1/fafo-resolve"
  cp -r "$SKILL" "$1/fafo-resolve"
  echo "skill  → $1/fafo-resolve"
}

# ~/.agents/skills is scanned by devin, pi, omp and most agent CLIs;
# ~/.claude/skills is Claude-native. Install both — cheap, harmless.
install_skill "$HOME_DIR/.agents/skills"
install_skill "$HOME_DIR/.claude/skills"

python3 - "$HOME_DIR" "$CLI" <<'PY'
import json, os, sys

home, cli = sys.argv[1], sys.argv[2]
entry = {"command": "npx", "args": ["tsx", cli, "mcp"]}

def merge(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cfg = {}
    if os.path.exists(path):
        try:
            cfg = json.load(open(path))
        except json.JSONDecodeError:
            print(f"mcp    ! {path} is not valid JSON — skipped", file=sys.stderr)
            return
    cfg.setdefault("mcpServers", {})["fafo"] = entry
    json.dump(cfg, open(path, "w"), indent=2)
    print(f"mcp    → {path} (mcpServers.fafo)")

merge(os.path.join(home, ".config/devin/mcp_config.json"))
# claude's mcpServers live in ~/.claude.json — merge only if the file
# already exists (don't fabricate Claude state on non-Claude homes)
p = os.path.join(home, ".claude.json")
if os.path.exists(p):
    merge(p)
PY

echo "done — TYPESAFE_API_KEY must be in the agent's environment for fafo_resolve"
