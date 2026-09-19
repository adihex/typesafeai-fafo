# Rune — command aliases

Rune is not a VS Code fork — no `.vsix` host. Its native extension system
(`~/.rune/extensions/`) is opaque/undocumented; the supported surface is
`command.aliases` in `~/.rune/config.yaml`, where `!!` runs a shell line
with `$FILE` / `$WORKSPACE_PATH` substitution.

```yaml
command:
  aliases:
    fafo:      "!! . /path/to/typesafeai-fafo/.env && npx tsx /path/to/packages/cli/src/cli.ts resolve \"$FILE\""
    fafocheck: "!! . /path/to/typesafeai-fafo/.env && npx tsx /path/to/packages/cli/src/cli.ts resolve --check \"$FILE\""
    fafoall:   "!! . /path/to/typesafeai-fafo/.env && npx tsx /path/to/packages/cli/src/cli.ts resolve"
```

Then in Rune's command prompt (`:`): `fafo` resolves conflicts in the
current file, `fafocheck` dry-runs (decisions only, nothing written),
`fafoall` resolves every conflicted file in the workspace. Escalated
hunks keep their markers — re-open/reload the buffer to see the result.

Sourcing the repo `.env` supplies `TYPESAFE_API_KEY`; launch Rune from a
shell that already exports it to skip the `.env` dependency.
