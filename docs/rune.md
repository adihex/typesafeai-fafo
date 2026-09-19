# Rune — command aliases

Rune is not a VS Code fork — no `.vsix` host. Its native extension system
(`~/.rune/extensions/`) is opaque/undocumented; the supported surface is
`command.aliases` in `~/.rune/config.yaml`, where `!!` runs a shell line
with `$FILE` / `$WORKSPACE_PATH` substitution.

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
