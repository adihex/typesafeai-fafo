# Zed

Three levels; the first two are installed already in `~/.config/zed/`.

## Context server (MCP into the Agent Panel)

`settings.json` has a top-level `context_servers.fafo` spawning
`fafo-resolve mcp` via `zsh -lc` that sources the repo `.env` — the key
never lands in settings. The `turbo` agent profile allows all fafo tools
(`"fafo": {"tools": {"fafo_scan": true, "fafo_resolve": true}}` — a
profile `context_servers` entry requires an explicit `tools` map; `{}`
fails settings parsing with `missing field 'tools'`).

The stdio entry shape is flat — `command` is the executable string, with
`args`/`env` as siblings (`context_servers` is an untagged enum; there is
no `"source": "custom"` key and `settings` belongs to the extension
variant only):

```json
"context_servers": {
  "fafo": {
    "command": "/bin/zsh",
    "args": ["-lc", "set -a; . /path/to/typesafeai-fafo/.env; set +a; exec npx tsx /path/to/packages/cli/src/cli.ts mcp"]
  }
}
```

Tools: `fafo_scan` (conflicts + hunk counts, no key), `fafo_resolve`
(pipeline; `check: true` dry-runs). In the Agent Panel: "scan this repo
for conflicts" / "resolve the conflicts in api.ts with fafo".

## Tasks

`tasks.json` has **FAFO: resolve conflicts in file** (`$ZED_FILE`) and
**FAFO: resolve all conflicts** — `task: spawn` from the palette.
Exit 1 = escalations remain; exit 2 = usage error.

## Extension (`integrations/zed/`)

Rust/WASM scaffold — `[context_servers.fafo]` manifest +
`context_server_command` returning the MCP spawn command. Per-project
`settings.api_key` / `settings.cli` (WASM can't read process env, so the
key comes via settings). Verified: compiles clean to `wasm32-wasip1`.

```sh
cd integrations/zed && cargo build --target wasm32-wasip1
# then in Zed: `zed: install dev extension` on this directory
```
