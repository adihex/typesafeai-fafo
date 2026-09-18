# FAFO Resolve (VS Code extension)

Jev-assisted merge-conflict resolution inside the editor. Code enumerates the
candidate resolutions (`@fafo/core`), TypeSafe's Jev selects/verifies one per
hunk; low-confidence or failed-verification hunks keep their conflict markers
for a human.

## Features

- **`FAFO: Resolve conflicts in this file`** — resolves every `<<<<<<< … >>>>>>>`
  hunk in the active editor and writes the result back. Escalated hunks keep
  their markers.
- **Per-hunk CodeLens** — "Resolve with Jev" above each `<<<<<<<` marker
  (plus "Resolve all" on the first). After resolving, the lens shows the
  verdict inline: `jev → theirs · conf 0.92 · cov 0.88` or
  `escalated: <reason>` (with a retry lens). Verdicts clear on any edit.
- **Decision log** — the `FAFO Resolve` output channel records every verdict:
  file, hunk, candidate, confidence, coverage, winner verify, token usage, and
  per-window traces for decomposed hunks. `FAFO: Show decision log` opens it.
- **API key** — `TYPESAFE_API_KEY` env var first, then the `fafo.apiKey`
  setting. Held in memory only; never written to SecretStorage or disk.
- **Settings** — `fafo.minConfidence`, `fafo.minCoverage`, `fafo.minVerify`,
  `fafo.noVerify`, `fafo.decompose`, `fafo.maxWindows`, `fafo.contextLines`,
  `fafo.model` — all mapped onto `@fafo/core`'s `ResolveOptions`.

## Build

```sh
pnpm install
pnpm --filter ./packages/vscode build   # → dist/extension.cjs (esbuild bundle)
```

`@fafo/core` is bundled from TypeScript source; only `vscode` is external.

## Manual test plan (needs a live editor — not covered by unit tests)

1. From the repo root, run `pnpm --filter ./packages/vscode build`.
2. Open the repo in VS Code, press **F5** (launch config "Run Extension" —
   rebuilds first, then starts an Extension Development Host).
3. In the dev host, set `fafo.apiKey` in settings *or* export
   `TYPESAFE_API_KEY` before launching VS Code.
4. Open a file containing git conflict markers (e.g. run a real merge, or
   paste a `<<<<<<< / ======= / >>>>>>>` block into a scratch file saved to
   disk — CodeLens only runs on `file://` documents).
5. **Lens check**: a "Resolve with Jev" lens appears above each marker;
   "Resolve all with Jev" on the first.
6. Click **Resolve with Jev** on one hunk → the hunk is replaced by the
   winner, or the markers stay with an `escalated: <reason>` lens + "Retry
   with Jev".
7. Run **FAFO: Resolve conflicts in this file** → all remaining hunks
   resolve; escalated ones keep markers; verdict lenses appear at each hunk's
   new position.
8. Open **FAFO: Show decision log** → per-hunk candidate/conf/cov/usage lines.
9. Remove the API key and re-run → error message offers to open settings.

### Not verifiable without a live editor

- CodeLens rendering/positions and the post-edit verdict anchoring (unit
  tests cover the line math, not the UI).
- `withProgress` notification, `editor.edit`/`applyEdit` behavior, and the
  doc-version guard against mid-ask edits.
- Real Jev calls (needs `TYPESAFE_API_KEY`); unit tests stub nothing — they
  only cover pure helpers.

## Unit tests

```sh
pnpm --filter ./packages/vscode test
```

Covers the pure seams: option mapping (`toResolveOptions`), key precedence
(`resolveApiKey`), single-hunk document extraction (`singleHunkText`), and
post-resolve verdict line mapping (`resolvedStartLines`, `verdictText`).

## Layout

- `src/extension.ts` — activation, command registration, context key
- `src/run.ts` — resolve orchestration (whole file + single hunk), API key wiring
- `src/codelens.ts` — per-hunk lenses + verdict store
- `src/hunks.ts` — pure hunk/verdict helpers (unit-tested)
- `src/settings.ts` — pure config → `ResolveOptions` mapping (unit-tested)
- `src/log.ts` — `FAFO Resolve` output channel
