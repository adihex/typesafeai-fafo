# Jujutsu (jj) — `jj resolve --tool fafo`

`jj resolve` invokes an external 3-way merge tool per conflicted file. fafo's
`--threeway` mode speaks that contract: `git merge-file` synthesizes the
marked-up conflict from base/ours/theirs, Jev adjudicates each hunk, the
result is written to `$output`, exit 0 iff every hunk applied (escalated
hunks keep their markers → jj leaves the path conflicted).

```sh
jj config set --user merge-tools.fafo.program npx
jj config set --user merge-tools.fafo.merge-args \
  '["tsx", "/path/to/packages/cli/src/cli.ts", "resolve", "--threeway", "$base", "$left", "$right", "$output"]'
```

Then: `jj resolve --list` to see conflicted paths, `jj resolve --tool fafo`
to adjudicate all of them (one tool invocation per file — stop early by
exiting without changes). `TYPESAFE_API_KEY` must be set.

The same 4-arg shape works for `git mergetool`-style `$BASE $LOCAL $REMOTE
$MERGED` callers that prefer explicit sides over marker parsing:

```sh
fafo-resolve resolve --threeway "$BASE" "$LOCAL" "$REMOTE" "$MERGED"
```
