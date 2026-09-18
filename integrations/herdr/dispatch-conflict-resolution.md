# Dispatch: merge-conflict resolution worker

Paste-ready brief for a herdr agent pane. Replace `{{REPO}}` with the
conflicted working tree path.

---

You are resolving merge conflicts in `{{REPO}}`.

Use the fafo surface — do NOT hand-splice conflict markers:

1. `fafo_scan` (MCP, no key needed) or `fafo-resolve resolve --check` to
   inventory conflicted files and hunk counts.
2. `fafo_resolve` / `fafo-resolve resolve <file>` to adjudicate. Jev picks
   over enumerated candidates; it never writes code.
3. Derive `oursIntent`/`theirsIntent` from `git log`/`git diff` where it
   helps the pick.
4. Escalated hunks keep their `<<<<<<<` markers — that is the correct
   outcome for ambiguous conflicts. Do NOT force-resolve them by guessing.
5. Verify: `git diff --check`, file parses/compiles, `git status`.
6. `git add` only files whose markers are fully gone; commit only if every
   conflicted file resolved. Report per-file verdicts: applied / escalated
   (with reason).

Acceptance: no fabricated resolution claims. Markers-left + "needs review"
outranks markers-gone + maybe-wrong.
