# lazygit integration

Two `customCommands` for `config.yml`: resolve the file under the cursor,
or resolve everything via `git mergetool`.

```yaml
customCommands:
  # Resolve the conflicted file under the cursor; re-stage on success.
  - key: "R"
    description: "fafo-resolve: Jev-adjudicate this file's conflicts"
    context: "files"
    subprocess: true
    command: >-
      git ls-files -u -- "{{.SelectedFile.Name}}" | grep -q .
      && fafo-resolve resolve "{{.SelectedFile.Name}}"
      && git add "{{.SelectedFile.Name}}"

  # Resolve every conflicted file via the fafo mergetool (needs
  # `fafo-resolve install-mergetool` once). Stages successes itself;
  # escalated files stay unmerged.
  - key: "M"
    description: "fafo-resolve all conflicts (git mergetool)"
    context: "files"
    subprocess: true
    command: "git mergetool --tool=fafo --no-prompt"
```

## Install

1. Merge the `customCommands:` block into lazygit's `config.yml`:
   - macOS: `~/Library/Application Support/lazygit/config.yml`
   - Linux: `~/.config/lazygit/config.yml`
   - (open lazygit → `e` on `status` → "Open config" works too)
2. `export TYPESAFE_API_KEY=...` in the shell you launch lazygit from —
   subprocesses inherit lazygit's environment.
3. For the `M` command only: `fafo-resolve install-mergetool` once
   (writes `merge.tool`/`mergetool.fafo.cmd` into git config).

## Behavior notes

- `subprocess: true` drops you into a terminal so the per-hunk verdicts
  (`apply <candidate> (conf …, cov …)` / `ESCALATE <reason>`) stay
  visible; any keypress returns to lazygit, which refreshes.
- The `R` chain: `ls-files -u` refuses on non-conflicted files (so you
  can't accidentally stage a merely-modified file), `resolve` runs, and
  `git add` fires only on exit 0 — i.e. every hunk applied. Escalated
  hunks keep their markers and the file stays unmerged for manual work.
- `git mergetool` runs the tool once per conflicted file and stages each
  success individually; `resolve`'s exit code is the per-file verdict.
- `R`/`M` are suggestions — any unbound keys work.
