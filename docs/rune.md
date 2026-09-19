# Rune

Three integration levels:

1. **Native Go extension** (`integrations/rune-go/`, recommended) — links
   `packages/core-go` in-process via `github.com/unstablebuild/rune-go-sdk`:
   `fafo` / `fafo check` / `fafo all` commands, per-hunk verdict
   notifications, and escalated hunks pushed to the file's location list
   (`location_next` to walk them). No `npx`/`tsx` subprocess and no
   `execute` permission — the resolver is a library call, filesystem
   access goes through Rune's workspace fs API. Register it in
   `~/.rune/config.yaml`:

   ```yaml
   extensions:
     fafo:
       path: "/path/to/typesafeai-fafo/integrations/rune-go"  # dir with go.mod
       config:
         fafo:
           env_file: "/path/to/typesafeai-fafo/.env"  # holds TYPESAFE_API_KEY
   ```

   Rune runs `go -C <dir> run .` against the committed `go.mod`/`go.sum`
   (read-only module mode), so `go.sum` must stay committed and the
   `replace ../../packages/core-go` means this layout only works inside
   the repo — a packaged install would need `go mod vendor` or a
   published core-go module. Key resolution order: process env
   `TYPESAFE_API_KEY` → `fafo.api_key` config → the env file.
2. **Python extension** (`integrations/rune/`) — same command surface
   over `rune-sdk`, but each command spawns the TypeScript CLI via
   `npx tsx` (needs `execute` permission + the `fafo.cli` config key).
   Kept as a reference/fallback.
3. **Command aliases** (below) — zero-dependency fallback using
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
