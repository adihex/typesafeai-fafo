# Herdr — conflict-resolution workers

Herdr panes run agents under the user's real HOME, so once fafo's surfaces
are installed globally every worker sees them: the skill
(`~/.agents/skills/fafo-resolve`, `~/.claude/skills/fafo-resolve`) fires on
conflict-shaped prompts, and the `fafo` MCP server exposes `fafo_scan` /
`fafo_resolve`.

`herdr integration` is a fixed registry of agent-state hooks — fafo is not
(and cannot be) a herdr integration. What this directory provides instead:

## `provision.sh [home]`

Installs the skill + MCP entry into any HOME. Idempotent; merges
`mcpServers.fafo` instead of clobbering other servers. Default `$HOME`;
pass a worker/fake HOME to isolate.

```sh
./provision.sh                  # real HOME (all herdr panes get fafo)
./provision.sh /tmp/worker-home # dedicated worker home (eval-style)
```

## `dispatch-conflict-resolution.md`

Paste-ready task brief. Spawn a pane, start an agent, hand it the brief:

```sh
herdr pane split
herdr agent start --kind devin --model swe-2-max --name resolve
herdr agent prompt resolve "$(sed "s|{{REPO}}|$PWD|" dispatch-conflict-resolution.md)"
```

Works for any `--kind` (claude, codex, droid, pi…) — provision.sh covers
the skill/MCP layer; the agent's own runtime handles the rest.
`TYPESAFE_API_KEY` must be in the agent's environment for `fafo_resolve`
(`fafo_scan` is keyless).
