# Rune

Two integration levels:

1. **Native extension** (`integrations/rune/`, recommended) — a real
   `rune-sdk` child-process extension: `fafo` / `fafo check` / `fafo all`
   commands, per-hunk verdict notifications, and escalated hunks pushed to
   the file's location list (`location_next` to walk them). Dev-loop with
   `extensions start fafo <python> integrations/rune/main.py`; see
   `integrations/rune/README.md`.
2. **Command aliases** (below) — zero-dependency fallback using
   `command.aliases` + `!!` shell lines.

## Command aliases

Rune is not a VS Code fork — no `.vsix` host. It has a real SDK
(`pip install rune-sdk`, extensions are child processes over gRPC on a
unix socket), but for a quick fallback `command.aliases` in
`~/.rune/config.yaml` runs `!!` shell lines with `$FILE` /
`$WORKSPACE_PATH` substitution.

```yaml
command:
  aliases:
    fafo:      "!! set -a; . /path/to/typesafeai-fafo/.env; set +a; npx tsx /path/to/packages/cli/src/cli.ts resolve \"$FILE\""
    fafocheck: "!! set -a; . /path/to/typesafeai-fafo/.env; set +a; npx tsx /path/to/packages/cli/src/cli.ts resolve --check \"$FILE\""
    fafoall:   "!! set -a; . /path/to/typesafeai-fafo/.env; set +a; npx tsx /path/to/packages/cli/src/cli.ts resolve"
```

Then in Rune's command prompt (`:`): `fafo` resolves conflicts in the
current file, `fafocheck` dry-runs (decisions only, nothing written),
`fafoall` resolves every conflicted file in the workspace. Escalated
hunks keep their markers — re-open/reload the buffer to see the result.

The `set -a` wrapper is required: the `.env` entries are not `export`ed,
so plain sourcing leaves them invisible to the `npx` child process.
Launch Rune from a shell that already exports `TYPESAFE_API_KEY` to skip
the `.env` dependency entirely.
