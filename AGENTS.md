# typesafeai-fafo

Jev-as-merge-conflict-adjudicator prototype. Jev never writes code — it
selects/verifies over a candidate set code enumerates; low confidence or
failed coverage/verification escalates the hunk (markers stay in the file).

## Layout

- `packages/core` (`@fafo/core`) — headless lib. Everything is pure except
  the injected `Asker` (bound `TypeSafeClient.systemOne`).
- `packages/cli` (`fafo-resolve`) — thin adapter: `resolve`, `dig`, `eval`.
- `packages/vscode` (`fafo-resolve` ext) — VS Code UI: command + per-hunk
  CodeLens + decision-log channel. esbuild bundles core to `dist/extension.cjs`.

## Commands

- `pnpm install` · `pnpm -r typecheck` · `pnpm -r test` (vitest, stubbed asker)
- `npx tsx packages/cli/src/cli.ts resolve [--check] [--json] [files...]`
- `npx tsx packages/cli/src/cli.ts install-mergetool [--local] [--diff3]`
- `npx tsx packages/cli/src/cli.ts dig <repo> [--out corpus.jsonl] [--limit N]`
- `npx tsx packages/cli/src/cli.ts dig <repo> --prs [--no-fetch]` — harvest conflicts from every open PR (needs `gh`; `resolved:null` entries, eval reports apply-vs-escalate)
- `npx tsx packages/cli/src/cli.ts eval <corpus.jsonl> [--json]`
- `npx tsx packages/cli/src/cli.ts report <eval.json> [--out report.html]`
- `npx tsx packages/cli/src/cli.ts mcp` — stdio MCP server: `fafo_scan`
  (conflicted files + hunk counts, no key needed) and `fafo_resolve`
  (the resolve pipeline; `check:true` dry-runs).

Live calls need `TYPESAFE_API_KEY`. `git merge-tree --write-tree` exits 1 on
conflicts (that's the harvestable case, not an error).

Integrations: `install-mergetool` registers fafo for `git mergetool`
(exit 0 = file resolved, nonzero = still conflicted); lazygit block in
`docs/lazygit.md`; agent skill in `skills/fafo-resolve/`.
