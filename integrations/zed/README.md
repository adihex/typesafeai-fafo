# FAFO × Zed

Three levels, easiest first.

## 1. Context server (installed — zero code)

`~/.config/zed/settings.json` now has a top-level `context_servers.fafo`
spawning `fafo-resolve mcp` through a `zsh -lc` wrapper that sources the repo
`.env` (keeps `TYPESAFE_API_KEY` out of settings). The Agent Panel's `turbo`
profile has `"fafo": {}` enabling both tools.

Tools the agent sees: `fafo_scan` (conflicted files + hunk counts, no key
needed) and `fafo_resolve` (the resolve pipeline; `check:true` dry-runs).

## 2. Tasks (installed)

`~/.config/zed/tasks.json` gained:

- **FAFO: resolve conflicts in file** — `resolve "$ZED_FILE"`
- **FAFO: resolve all conflicts** — `resolve` over the worktree

Run via `task: spawn` in the command palette. Exit 1 = escalations remain
(markers kept — honest, not an error); exit 2 = usage error.

## 3. Extension scaffold (this directory)

A distributable Zed extension: `[context_servers.fafo]` in `extension.toml`
plus `context_server_command` in `src/lib.rs` returning the MCP spawn
command. Per-project settings:

```json
"context_servers": {
  "fafo": {
    "settings": {
      "api_key": "…",
      "cli": "npx tsx /path/to/typesafeai-fafo/packages/cli/src/cli.ts"
    }
  }
}
```

Build: `cargo build --target wasm32-wasip1` then `zed: install dev extension`
on this directory. Note WASM can't read process env — that's why `api_key`
comes through settings rather than the environment.
