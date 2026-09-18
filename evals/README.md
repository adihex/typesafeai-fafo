# evals/ — agent-surface eval suite

Claude-`plugin eval`-style discipline ported to devin headless: does the
fafo **skill** and **MCP server** actually steer an agent to the right
outcome, vs a baseline agent with neither?

Each case is a directory: `prompt.md` (what a user would type — no tool
names unless the case is testing discovery) + `fixture.sh` (plants a git
repo with the needed conflict) + `graders.yaml` (deterministic pass/fail
checks — no LLM judges, transcripts + file state only).

## Run

```sh
./evals/run.sh                 # all cases × RUNS × both arms
./evals/run.sh inventory-scan  # one case
RUNS=1 ARMS=with ./evals/run.sh resolve-applies   # cheap iteration
```

Per run: build a scratch repo → `devin -p --export transcript.json` in it
→ grade transcript + file state. Score = fraction of graders passed;
case score = mean over RUNS (default 3). Report prints WITH / W/OUT / Δ
per case — **Δ is the number that matters**: a case the baseline also
passes proves the surface contributed nothing.

The `without` arm runs the agent with `HOME` pointed at a skeleton dir
(auth copied, `~/.agents/skills/` and `~/.config/devin/mcp_config.json`
absent) — same model, no fafo surfaces.

## Grader kinds (deterministic)

| kind | check |
|---|---|
| `transcript_contains` | regex over exported transcript — tool calls, commands, agent's own words |
| `file_contains` / `file_lacks` | regex over a fixture file after the run — markers gone? expected line present? |
| `exit_code` | devin's exit status |

## The seams under test

- **skill fires on natural phrasing** — the #1 failure mode per Claude's
  eval docs; if `description` doesn't trigger, no one ever runs the tool
- **MCP discoverability** — does the agent call `fafo_scan`/`fafo_resolve`
  rather than hand-editing markers?
- **escalation contract** — when Jev declines, markers must remain AND the
  agent must not claim done. The safety story is only real if agents
  respect it end-to-end
- **apply path** — clean conflicts actually get resolved and written
