# fafo-resolve

Merge conflicts adjudicated by TypeSafe Jev —
a **selector, not a generator**. Jev never writes code: it chooses from a
candidate set the code enumerates, then verification gates decide whether
that pick is trusted.

## The model

For each `<<<<<<< … ======= … >>>>>>>` hunk, `enumerateCandidates` builds
the complete resolution space:

`ours` · `theirs` · `both-ours-theirs` · `both-theirs-ours` · `union` ·
`base` (diff3 only) · `drop` — plus `spliced`, a line-level merge produced
by decomposing the hunk into shared anchors + differing windows.

One System One request fans out per hunk: a **Choice** over the candidates
(+ `needs-novel-merge`), a **coverage** noul ("is the right answer in this
set at all?"), and a **verify** noul per candidate ("does this preserve
both sides' intent?"). `interpret` turns those judgments into policy:

- **apply** — splice the winner's lines in. Done.
- **escalate** — markers stay in the file. Escalations aren't failures;
  they're the gate working: `novel-merge-needed`, `not-in-candidates`,
  `verification-failed`, `low-confidence`, `ask-failed`.
- Escalated (or coverage-hedged) hunks retry per-window before giving up —
  the `spliced` candidate. A window-level verdict is strictly better
  information than a whole-hunk shrug.

Exit code is the contract: `0` = every hunk applied, `1` = something
escalated. Chain it: `fafo-resolve resolve && git add -u`.

## Install

```sh
git clone <this-repo> && cd typesafeai-fafo
pnpm install
export TYPESAFE_API_KEY=...        # live calls need it
```

Run from source: `npx tsx packages/cli/src/cli.ts <cmd>` — or link it for
a real `fafo-resolve` on PATH (`cd packages/cli && pnpm link --global`).

Layout: `packages/core` (`@fafo/core`) is the headless, pure library —
the only impurity is the injected `Asker`. `packages/cli` is a thin
adapter over it.

## Commands

### `resolve` — the day job

```sh
fafo-resolve resolve [files...]     # default: git's unmerged list
  --check             report decisions, write nothing
  --json              machine-readable per-hunk outcomes on stdout
  --ours-intent T     what our change was trying to do (commit msg, free text)
  --theirs-intent T   same for theirs
  --context N         context lines around each hunk (default 15)
  --min-confidence F  escalate below this choice confidence (default 0.5)
  --min-coverage F    escalate below this coverage noul (default 0.5)
  --min-verify F      reject winner below this verify noul (default 0.5)
  --no-verify         skip per-candidate verification nouls
  --no-decompose      skip per-window retry on escalated hunks
  --model M           model override (default jev-latest)
```

stderr narrates each hunk: `apply <candidate> (conf …, cov …)` or
`ESCALATE <reason>`.

### `install-mergetool` — wire into `git mergetool`

```sh
fafo-resolve install-mergetool          # global (user) config
  --local       repo-local instead
  --diff3       also set merge.conflictStyle=diff3 (BASE section → better picks)
  --cmd 'CMD'   override the invoked command
```

Writes `merge.tool=fafo`, `mergetool.fafo.cmd`, `trustExitCode=true`.
Then `git mergetool` calls `resolve` once per conflicted file as
`$MERGED`: exit 0 stages it (git drops a `<file>.orig` backup unless
`mergetool.keepBackup=false`), nonzero leaves it unmerged.

### `dig` — harvest conflict corpora

```sh
fafo-resolve dig <repo> --out corpus.jsonl --limit 50
```

Re-runs each merge commit via `git merge-tree --write-tree`, rebuilds
conflicted files (diff3), records the human's resolution as truth.
Optional `intents.json` sidecar (merge SHA → commit subjects) feeds
`--ours-intent`/`--theirs-intent` during eval.

### `eval` — score the resolver

```sh
fafo-resolve eval corpus.jsonl --json > eval.json
```

Runs the resolver over the corpus and compares against recorded truth:
`match` / `DIFFERS` / `escalated`. Summary reports `matchRate` over
applied hunks only — escalations are the gate, neither right nor wrong.

### `report` — read that eval

```sh
fafo-resolve report eval.json --out eval.html     # default: stdout
```

Single self-contained HTML file: per-file verdict badges, per-hunk picked
candidate with confidence/coverage/reason, side-by-side
ours/theirs/resolution snippets, per-window traces, fafo-vs-human
full-file compare. No deps, no build step.

## Integrations

- **git mergetool** — `fafo-resolve install-mergetool`, then `git
  mergetool` (see above).
- **lazygit** — `customCommands` block for config.yml:
  [docs/lazygit.md](docs/lazygit.md). Resolve file under cursor +
  re-stage, or resolve all via mergetool.
- **agents** — `skills/fafo-resolve/SKILL.md`, installable via `npx
  skills add <this-repo>`: tells an agent to run `resolve`, treat applied
  hunks as done, and take escalated hunks (markers left behind) as its
  own queue.
- **CI / scripts** — `resolve --check --json` gives a dry-run verdict
  stream; exit code 0/1 gates pipelines.

## Dev

```sh
pnpm -r typecheck
pnpm -r test          # vitest; stubbed asker, no API key needed
```

`.env` holds a local `TYPESAFE_API_KEY` (gitignored). `git merge-tree
--write-tree` exits 1 on conflicts — that's the harvestable case, not an
error.
