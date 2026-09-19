# FAFO × Rune

Native Rune extension (`rune-sdk`, Python): registers a `fafo` command manual
that adjudicates merge conflicts through the `fafo-resolve` CLI. Jev selects
from enumerated candidates only — escalation leaves markers in the file and
pushes each one onto the file's location list (`location_next`/`location_prev`
walk them like `:cnext`).

## Commands

| command | effect |
|---|---|
| `fafo` | resolve conflicts in the current file |
| `fafo check` | dry-run — verdicts as notifications, no writes |
| `fafo all` | resolve every `git diff --diff-filter=U` file in the workspace |

Every applied hunk notifies `candidate + confidence`; every escalation
notifies the reason and lands as an ERROR-priority location at its marker line.

## Dev loop

```sh
python3 -m venv .venv && .venv/bin/pip install rune-sdk
# in Rune's console:
extensions start fafo /path/to/integrations/rune/.venv/bin/python /path/to/integrations/rune/main.py
extensions logs fafo --tail 50
extensions restart fafo / extensions stop fafo
```

`extensions start <id> <cmd> [args...]` spawns the extension as a child
process over a private unix socket — no package needed while iterating.

## Packaging

Rune packages are gzipped tarballs: executable(s) under `bin/`, payload files,
and a top-level `config.yaml` overlay deep-merged into the user config
(`extensions.fafo.path` registers the launcher).

```sh
tar -czf fafo.rune.tar.gz -C integrations/rune bin main.py config.yaml
# then install via Rune's package manager (pkg install)
```

## Config / secrets

- `extensions.fafo.config.fafo.cli` — resolver argv (default `fafo-resolve`;
  point at a checkout with `npx tsx …/packages/cli/src/cli.ts`).
- `extensions.fafo.config.fafo.env` — extra env for the CLI subprocess.
- `TYPESAFE_API_KEY` is inherited from the extension's own environment.
  **Never put it in `config.yaml`** — that file ships inside the package.

## Why not the alias approach

The `command.aliases` fallback in `docs/rune.md` still works, but the SDK
extension gets real IDE surfaces aliases can't reach: per-hunk verdict
notifications, the escalation location list, workspace-relative file
resolution (`cmd.uri`), and lifecycle management via `extensions *`.
VS Code `.vsix` extensions are not supported by Rune at all.
