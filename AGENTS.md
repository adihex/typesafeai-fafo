# typesafeai-fafo

Jev-as-merge-conflict-adjudicator prototype. Jev never writes code — it
selects/verifies over a candidate set code enumerates; low confidence or
failed coverage/verification escalates the hunk (markers stay in the file).

## Layout

- `packages/core` (`@fafo/core`) — headless lib. Everything is pure except
  the injected `Asker` (bound `TypeSafeClient.systemOne`).
- `packages/cli` (`fafo-resolve`) — thin adapter: `resolve`, `dig`, `eval`.

## Commands

- `pnpm install` · `pnpm -r typecheck` · `pnpm -r test` (vitest, stubbed asker)
- `npx tsx packages/cli/src/cli.ts resolve [--check] [--json] [files...]`
- `npx tsx packages/cli/src/cli.ts dig <repo> [--out corpus.jsonl] [--limit N]`
- `npx tsx packages/cli/src/cli.ts eval <corpus.jsonl>`

Live calls need `TYPESAFE_API_KEY`. `git merge-tree --write-tree` exits 1 on
conflicts (that's the harvestable case, not an error).

Later: register as mergetool —
`git config --global mergetool.fafo.cmd 'fafo-resolve resolve $MERGED'`

## Known limits

- **Human-edit class**: some truths are hand-written edits no enumerated
  candidate can express — not ours/theirs/both/union/base/drop, and not
  any keep/drop subset of the union. ~9 entries on the diverse corpus.
  These are the escalation floor BY DESIGN: Jev selects, it never writes,
  so unenumerable resolutions correctly stay marked for a human. Do not
  chase them with more machinery — a resolver that generates code to match
  them is a different (and less trustworthy) product.
- **Composition misfires**: per-line splices can apply confidently wrong
  when the union lacks the needed lines — splice-verify does not
  discriminate for composed candidates. Mitigations in place: decisiveness
  gate (mean |keep-0.5| >= 0.2), novel-subset filter, drop audit over the
  lines a composition omits.
