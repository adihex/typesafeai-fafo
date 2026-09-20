# Agent-surface eval findings

Mission: which agent CLIs can a fafo user actually use today?
Surfaces under test: `skills/fafo-resolve` (SKILL.md) + `fafo-resolve mcp` (stdio MCP).
Harness: `evals/run.sh` — fake-HOME ablation, WITH (skill+MCP) vs W/OUT (auth only), Δ is the signal.
Metrics: `evals/lib/metrics.py` extracts per-row tokens/steps/tool-calls/`skill_fired`/`mcp_called`.

## Headline: final matrix (RUNS=3, evals/results/2026-09-18T14-50-36)

| runtime | mean Δscore | skill fired (WITH) | MCP called | verdict |
|---|---|---|---|---|
| codex | **+0.28** | 12/12 | 2/12 | works — fafo surfaces lift every case |
| grok | **+0.28** | n/a (no skill convention) | 10/12 | flagship — live `fafo_scan`/`fafo_resolve` |
| pi | **+0.28** | 12/12 | 0/12 | works via skill; MCP lazy-never-invoked |
| droid | **+0.22** | 10/12 | 0/12 | works via skill (stochastic on inventory) |
| omp | +0.00 | 0/12 | 0/12 | native `conflict://` surface; fafo adds nothing |
| agy, cmd, copilot, kilo, kiro-cli | +0.00 | — | — | auth gaps (timeouts / login-required exits) |
| crush | +0.00 | — | — | config gap — no providers |
| cursor-agent | +0.00 | — | — | binary missing (exit 127) |

WITH ≥ WITHOUT on every case of every working runtime; WITH=1.00 on
nearly every run. Blocked runtimes show Δ=0 with identical arms — the
fixture's partial credit explains their nonzero absolute scores.

## Correction: final-message transcripts hid the surfaces

Early runs captured only each agent's final message — "never mentioned fafo"
looked like "never loaded fafo". With structured transcripts (codex `--json`,
droid `-o stream-json`, pi `--mode json`, grok `--output-format streaming-json`):

| runtime | skill loads? | MCP invoked? | evidence |
|---|---|---|---|
| codex | yes (stochastic) | not yet observed | `cat $HOME/.codex/skills/fafo-resolve/SKILL.md` in `command_execution` |
| droid | yes (stochastic) | registered, not invoked | `Skill{skill:'fafo-resolve'}` → "now active" |
| pi | yes | configured, not invoked | `read` on SKILL.md (pi connects MCP lazily) |
| grok | n/a — no skill convention | **yes — live `fafo_scan`** | `use_tool{tool_name:'fafo__fafo_scan'}` → `server_name:'fafo', Ok` |

Every working runtime loads ≥1 surface. The skill is the reliable surface;
the MCP is reachable (grok proves it) but unevenly discovered.

## Arm-boundary integrity (fixed this phase)

- grok WITHOUT arm leaked fafo: real `~/.grok/config.toml` already had
  `[mcp_servers.fafo]` → now copied-minus-fafo in both arms, appended in WITH.
- cmd: real `settings.json` is a lone fafo block → WITHOUT gets `{}`.
- codex WITH wrote a fresh config (lost the `gpt-5.6-luna` pin + trusts) →
  now real-config-copy + fafo append, same as grok.
- droid `mcp.json` needs `"type":"stdio"` (verified against `droid mcp add`).

## Runtime status (non-devin; devin skipped — main lane owns it)

| runtime | status |
|---|---|
| codex, droid, pi, grok | working — full matrix RUNS=3 in `evals/results/` |
| agy | auth gap — antigravity OAuth doesn't transfer to fake HOME |
| copilot | auth gap — wants `/login`/PAT |
| cmd | auth gap — `cmd login` required |
| kilo | auth gap — "sign in to use this model" |
| kiro-cli | auth gap — Keychain/browser OAuth in fake HOME |
| omp | recovered from 429; runs clean — but Δ=0, see below |
| crush | config gap — "No providers configured" |
| cursor-agent | missing binary — uninstalled since recon |
| claude | seeded adapter, untested this lane |

## omp: Δ=0 because omp ships its own conflict surface

Adapter fixed (`~/.omp/agent/skills/fafo-resolve` — verified path — and
`--mode json` gives pi-family transcripts). All 8 rows exit-0, scores
0.67–0.80, but Δ=0 with zero skill/MCP on every run. The transcripts
explain why: omp resolves conflicts through **native tool primitives** —

- `read 'app.ts:conflicts'` — parses marker regions
- `write 'conflict://1' content='@both'` — a protocol URL write that
  applies a resolution directive

omp never reaches for a skill because its toolset already has a conflict
resolver. fafo competes with a built-in here; the skill's value would
need to be Jev's verification/escalation, which nothing in the prompt
makes omp reach for. Transcript carries no system-prompt echo, so
"skill offered but not chosen" vs "not offered" is indistinguishable —
either way the observable behavior is identical: fafo adds nothing.

## Transcript shapes → metrics.py coverage

| runtime | shape | metrics? |
|---|---|---|
| devin | `-p` export (steps/final_metrics) | native |
| codex | `exec --json` item.* + turn.completed.usage | yes |
| droid | `exec -o stream-json` tool_call/tool_result/result | yes — no token fields |
| pi | `-p --mode json` tool_execution_end/message.usage | yes |
| grok | `--single --output-format streaming-json` ACP | yes — no token fields |
| omp | `--mode json` tool_execution_* (pi family) | yes |

`jev_*` columns stay 0 off-devin: this branch's `mcp-tools.ts` predates the
`usage` emission (exists on integration/v1; packages/ untouched per dispatch).

## Adapter notes

- `codex`: `~/bin/codex` is a `$HOME`-relative shim → symlink `.local/bin/codex`,
  `.codex/auth.json`, `.codex/packages`.
- `pi`: shim needs `.bun`, `.local/share/mise`, `bin/pi`, `.pi/agent/*`;
  pin `openai-codex/gpt-5.6-luna`.
- `grok`: real config.toml gets fafo-stripped copy + append in WITH.
- run.sh (synced): `rt_fake_home <arm> <fixture-cwd>`; `row.py` merges metrics
  into each results.jsonl row; `report.py` prints the A/B table.
