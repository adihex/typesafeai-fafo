---
name: fafo-resolve
description: Resolve git merge conflicts with TypeSafe Jev — a selector over enumerated candidate resolutions, not a code generator. Use when a merge or rebase leaves conflict markers in files.
---

# fafo-resolve

Jev adjudicates merge conflicts. Code enumerates the candidate resolutions
(ours / theirs / both orderings / union / base / drop / line-spliced); Jev
picks, and gates (confidence, coverage, per-candidate verification) decide
whether the pick is trusted. **Applied hunks are done. Escalated hunks are
your queue — their markers stay in the file.**

## Prerequisites

`fafo-resolve` on PATH (or `npx tsx packages/cli/src/cli.ts` in the
typesafeai-fafo repo) and `TYPESAFE_API_KEY` exported.

## When you hit merge conflicts

```sh
git merge <branch>          # or rebase — anything that drops you into conflicts
fafo-resolve resolve        # resolves every unmerged file
```

Per-file stderr output tells you the outcome of each hunk:

- `apply <candidate> (conf …, cov …)` — done. The candidate's lines replaced
  the conflicted region.
- `ESCALATE <reason>` — Jev declined. The `<<<<<<<`/`=======`/`>>>>>>>`
  markers are still in the file; resolve that hunk yourself.

Exit code: `0` when every hunk applied, `1` when anything escalated —
safe to use as a gate in scripts and `&&` chains (e.g. `resolve && git add`).

Finishing up after a run:

```sh
fafo-resolve resolve            # exit 0 → all files fully resolved
git add -u && git commit        # or `git rebase --continue`
```

If some files escalated, fix the marked regions manually — Jev's verdict
line says why (`novel-merge-needed`, `not-in-candidates`,
`verification-failed`, `low-confidence`, `ask-failed`). `git status`
unmerged list tells you what's left.

## Options that matter to agents

- `fafo-resolve resolve <files...>` — explicit file list instead of git's
  unmerged set.
- `--check` — report decisions without writing (dry run).
- `--json` — machine-readable per-hunk outcomes on stdout.
- `--ours-intent T` / `--theirs-intent T` — tell Jev what each side was
  trying to do (commit message, PR description). Better picks.
- `--no-decompose` — skip the per-window retry on escalated hunks.

## Corpus tooling (context, not day-to-day)

```sh
fafo-resolve dig <repo> --out corpus.jsonl    # harvest real conflicts from merge history
fafo-resolve eval corpus.jsonl --json > eval.json   # score picks vs human resolutions
fafo-resolve report eval.json --out eval.html       # readable HTML of the eval
```

## Under a mergetool

`fafo-resolve install-mergetool` once, then `git mergetool` routes
conflicts through fafo — exit code is the per-file verdict, so successes
stage and escalations stay unmerged.
