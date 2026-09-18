# evals/ — agent-surface eval suite

Claude-`plugin eval`-style discipline, runtime-pluggable: does the fafo
**skill** and **MCP server** actually steer an agent to the right
outcome, vs a baseline agent with neither — across every agent CLI on
this machine?

Each case is a directory: `prompt.md` (what a user would type — no tool
names unless the case is testing discovery) + `case.yaml` (`fixture:`)
+ `graders` (deterministic pass/fail — no LLM judges, transcripts +
file state only).

## Run

```sh
export TYPESAFE_API_KEY=...                          # agents inherit it
./evals/run.sh                                       # devin, all cases, 3 runs × 2 arms
RUNTIMES="devin claude codex" ./evals/run.sh         # a matrix slice
RUNS=1 ARMS=with ./evals/run.sh resolve-applies      # cheap iteration
```

Per run: build a scratch repo → run the agent headless in it under a
prepared HOME → grade transcript + file state + extract metrics.
Score = fraction of graders passed; case score = mean over RUNS
(default 3). **Δ is the number that matters**: a case the baseline
also passes proves the surface contributed nothing.

## A/B metrics (report.py)

Each results row carries, alongside `score`/`secs`/`exit`/`graders`:

| field | source | what it answers |
|---|---|---|
| `agent_prompt_tokens` / `agent_completion_tokens` / `agent_cached_tokens` | transcript `final_metrics` | model cost — prompt tokens include skill+MCP schema weight, i.e. the plugin's context overhead |
| `agent_steps` | `final_metrics.total_steps` | agent effort |
| `tool_calls` / `tool_fns` | per-step `tool_calls` | exploration cost — does fafo replace manual git archaeology? |
| `skill_fired` | `skill` tool_call args | surface-discovery rate |
| `jev_input_tokens` / `jev_output_tokens` | `usage` in `fafo_resolve` results | Jev-side spend, WITH arm only |

Report columns per (runtime × case × arm): `score` (all graders),
`fileOK` (file-state graders only — correctness independent of
surface), `surf` (fafo surface use), `secs`, `steps`, `tools`,
`promptK`, `compl`, `jevK`, plus per-case Δscore and mean Δ.

New runtimes: `metrics.py` parses the **devin** export format; other
adapters may emit a different transcript shape — extend `metrics.py`
or accept `{}` (columns render `—`).

## Arms = prepared HOMEs

Every agent CLI reads config from `$HOME/.<something>`. Each runtime
adapter (`evals/runtimes/<name>.sh`) builds two fake HOMEs:

- **with** — auth bits (symlinked) + the fafo skill in that runtime's
  skill location + the MCP server in that runtime's config format
- **without** — auth only, no fafo surfaces

Same model, same prompt — the only variable is surface presence.

## Runtime adapters

`evals/runtimes/TEMPLATE.sh` documents the contract: `rt_fake_home
<with|without>` + `rt_invoke <prompt> <cwd> <transcript> <home>`.

Installed runtimes live in `evals/runtimes/*.sh`. Recon per new runtime:
`<cli> --help` for the headless flag, `ls ~/.<tool>` for config layout,
docs for its MCP config format. Quota-limited runtimes (e.g. claude's
5h window) score 0 on dead-window runs — re-run that slice when the
window resets; results accumulate per-run in `results/<ts>/results.jsonl`.

## Grader kinds (deterministic)

| kind | check |
|---|---|
| `transcript_contains` / `transcript_lacks` | regex over exported transcript — tool calls, commands, agent's own words |
| `file_contains` / `file_lacks` | regex over a fixture file — markers gone? expected line present? |
| `exit_code` | agent's exit status |

Prefix `orN:` to OR-group graders — the group passes if any member does
(used for "ended clean OR acknowledged leftover markers").

## The seams under test

- **skill fires on natural phrasing** — the #1 failure mode per Claude's
  eval docs; if `description` doesn't trigger, no one ever runs the tool
- **MCP discoverability** — does the agent call `fafo_scan`/`fafo_resolve`
  rather than hand-editing markers?
- **escalation contract** — when Jev declines, markers must remain AND the
  agent must not claim done. The safety story is only real if agents
  respect it end-to-end
- **apply path** — clean conflicts actually get resolved and written
- **per-runtime variance** — same surfaces, different conventions: whose
  skill format gets picked up, whose MCP config parses, whose agents
  ignore all of it
