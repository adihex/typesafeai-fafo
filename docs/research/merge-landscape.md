# Industrial merge-resolution landscape

Research for the fafo/Jev integration question: how does a learned
*selector* (not generator) fit inside a real software factory? This maps
the existing tooling stack — structured merge tools, merge queues, and
next-gen VCS conflict models — and marks where selector-based
adjudication demonstrably fits or fails.

fafo's model, for reference: code enumerates candidate resolutions
(flat: `ours`, `theirs`, `both-ours-theirs`, `both-theirs-ours`,
`union`, `base`, `drop`; composed: `spliced` via window decomposition
and guarded per-line keep/drop); Jev selects and verifies among them;
low confidence, insufficient coverage, failed verification or unsafe
composition escalates with markers preserved.

## 1. Structured / semantic merge tools

These tools don't enumerate candidates — they compute *one* merged
artifact deterministically and emit residual conflict markers when
their algorithm can't reconcile. That makes them complementary to a
selector, not competitive: their residuals are our input space.

| Tool | Substrate | What it computes | Residual output | Enumeration? |
|---|---|---|---|---|
| git merge (ort) | lines (xdiff) | single merged file | coarse hunk markers | none |
| mergiraf | tree-sitter CST → PCS triples | single merged tree | *narrower* markers | none |
| spork | Java AST (Spoon) | single merged AST | markers | none |
| JDime | Java AST, auto-tuning | single merged AST | markers | none |
| IntelliMerge | program element graph | single merged graph | markers | none |
| fuse | tree-sitter symbols | single merged file | markers + agent handoff | none |
| difftastic | syntax-aware *diff* | — (no merge) | n/a | n/a |
| AutoMerge | AST + version space algebra | **ranked candidate set** | interactive pick | explicit |
| MergeBERT | token 3-way diff + transformer | class over merge patterns | none (proposes only) | implicit |
| fafo | conflict-marked text + diff3 base | flat + composed candidates | markers preserved | explicit |

### mergiraf

Syntax-aware merge driver. Parses base/left/right with tree-sitter,
matches the three syntax trees with GumTree, maps them to PCS
(parent-child-successor) triples, merges the triple sets, then checks
for delete/modify conflicts and duplicate signatures before rendering.
Runs a fast line-based merge first and only invokes the tree machinery
on conflicts; falls back to line merge when files don't parse. Designed
to err conservative — it "retain[s] conflict markers in the file when
encountering suspicious cases" and offers `mergiraf review` to inspect
auto-resolved merges. Ships as a git merge driver, a post-hoc solver
(`mergiraf solve`), and a `jj resolve` tool.

- https://mergiraf.org/
- https://mergiraf.org/architecture.html
- https://mergiraf.org/usage.html
- https://codeberg.org/mergiraf/mergiraf
- https://docs.rs/mergiraf/latest/mergiraf/

Versus our candidate set: mergiraf can produce interleavings and
reorderings (e.g. two methods swapped, imports resorted) that no flat
candidate or our ours-block-then-theirs-block splice could express —
its composition space is structural and strictly larger than our
textual one. Conversely it offers *nothing* at its residual conflicts:
no ranked alternatives, no notion of "this hunk wants both edits minus
one line". A selector layered on mergiraf residuals inherits its
narrower, better-aligned hunks for free.

### spork

Academic structured merge for Java (Larsén, Falleri, Baudry,
Monperrus; TSE 2022). Spoon AST + GumTree matching + the 3DM merge
algorithm (Lindholm), with formatting preservation via a
reparse/pretty-print hybrid. Benchmarked on 1740 real file merges from
119 projects against JDime: comparable median speed, better tail
latency, fewer but slightly larger conflicts, no statistically
significant correctness difference. Mergiraf's architecture page
states it "broadly follows the architecture of spork".

- https://github.com/ASSERT-KTH/spork
- https://arxiv.org/abs/2202.05329
- https://doi.org/10.1109/TSE.2022.3143766

### "langfusion" → the semantic-merge family

No tool named *langfusion* exists (GitHub search returns zero repos;
the name collides with the unrelated Langfuse observability platform).
Interpreting the intended category — language-aware/semantic merge —
the lineage is:

- **FSTMerge** (Apel et al., FSE 2011) — semistructured merge: parses
  only to declaration level, merges the declaration tree, leaves
  method bodies as text. Established the precision/formatting
  trade-off the field still argues about.
  https://www.se.cs.uni-saarland.de/publications/docs/FSE2011.pdf
- **JDime** (Leßenich/Seibt et al., ASE 2017) — structured merge with
  auto-tuning: switches between unstructured and structured merge per
  conflict to balance precision vs runtime.
  https://www.se.cs.uni-saarland.de/projects/jdime/
  https://github.com/se-sic/jdime
- **IntelliMerge** (Shen et al., OOPSLA 2019) — refactoring-aware
  merge over program element graphs; −58.9% conflicts vs git-merge,
  −11.8% vs jFSTMerge on 1070 Java scenarios.
  https://doi.org/10.1145/3360596
  https://github.com/Symbolk/IntelliMerge
- **fuse** (provasign) — current-generation symbol-aware merge driver:
  escalation ladder line-merge → tree-sitter symbol merge, every clean
  result re-parsed before shipping (a merge that doesn't parse is
  discarded as a conflict), survivors get git markers plus an
  AI-handoff prompt with blast-radius context. Notable because it
  validates output syntactically — the same repair/verify instinct as
  our composed-file sanity pass.
  https://github.com/provasign/fuse

### "difftastic-merge" → difftastic is diff-only

There is no difftastic merge mode. The README is explicit: "Can
difftastic do merges? No. AST merging is a hard problem that
difftastic does not address … The mergiraf tool does offer merges."
Since v0.50 it *parses* conflict markers to show a structural diff of
LHS vs RHS — but ignores the base side entirely (no 3-way structural
diff) and produces no merge output. Relevant only as an adjudication
UI surface, not a resolver.

- https://github.com/Wilfred/difftastic
- https://github.com/Wilfred/difftastic/issues/565
- https://deepwiki.com/Wilfred/difftastic/6.3-conflict-resolution

### AutoMerge — the selector precedent

Zhu & He (OOPSLA 2018): the canonical enumerate-then-select system.
Runs structured merge to a program-with-holes, represents each hole's
candidate resolutions as a version space algebra (a possibly huge
program space), ranks them with hand-written "prior to" rules lifted
to VSAs, and presents top-ranked resolutions for the developer to
accept or reject. On 244 real conflicts that JDime *could not*
resolve: 95.1% resolved, averaging 1.79 candidates tried. Its three
documented failure classes map exactly onto ours:

- *assumption violation* — truth is not a combination of left and
  right (our human-edit floor),
- *insufficient expressiveness* — VSA root must match one side's
  node kind (our candidate-set limits),
- *huge program space* — ranking drowns (our honest-ambiguity pool).

- https://doi.org/10.1145/3276536
- https://feihe.github.io/materials/oopsla18.pdf
- https://github.com/thufv/automerge

Jev replaces AutoMerge's hand-written ranker + human accept/reject
loop with learned selection plus confidence/coverage/verification
gates. Same skeleton, different decision-maker.

### MergeBERT — learned classification over merge patterns

Svyatkovskiy et al. (FSE 2022, Microsoft): token-level 3-way
differencing feeds a transformer that *classifies* each conflict into
primitive merge patterns extracted from real merge commits — take
ours, take theirs, concat ours→theirs, concat theirs→ours, interleave
lines, plus a small set of edit types. Note that this is selection
over a pattern set (≈ our flat candidate kinds + an interleave class),
not free generation — they explicitly "reformulate the task of
generating the resolution sequence as a classification task". Reported
63–68% precision at synthesis across Java/JS/TS/C#.

- https://arxiv.org/abs/2109.00084
- https://www.microsoft.com/en-us/research/publication/program-merge-conflict-resolution-via-neural-transformers/

That ~2/3 precision *without* gating is the empirical case for fafo's
design: a learned pick applied unconditionally lands exactly in
MergeBERT's precision band; the gates (verify, coverage, discard,
novel-subset, decisiveness) are what make applies trustworthy.

## 2. Merge-queue semantics

Queues solve *semantic* skew (main breaks after unrelated merges
interact), not textual conflicts. Every queue below treats a textual
conflict as a dequeue-and-report event — none resolves anything.

| Queue | Unit | How conflicts surface | Auto-resolution |
|---|---|---|---|
| GitHub merge queue | PR / merge group | PR auto-removed from queue; group re-forms | none |
| bors-ng | batch on `staging` | batch fails, bisects O(E log N), PR reported | none |
| Zuul | change in dependent pipeline | item dequeued, "Merge failed" reported | none |
| Graphite | stack of PRs | rebase conflict → manual `gt restack`/`gt continue` | none |

### GitHub merge queue

Queued PRs are grouped onto temporary `gh-readonly-queue/*` branches;
CI must run on the `merge_group` event. "Pull requests in the queue
that conflict with one another are automatically detected and removed,
with the queue automatically re-forming groups as needed" — detection
is by attempting the merge. The design goal is explicitly throughput
over fairness. Resolution is pushed back to the PR author — and since
April 2026 the github.com path offers a **"Fix with Copilot"** button:
Copilot cloud agent resolves the conflicts, runs build/tests, and
pushes. That's a *generator* on the PR side of the queue, with CI as
the only gate.

- https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue
- https://github.blog/engineering/engineering-principles/how-github-uses-merge-queue-to-ship-hundreds-of-changes-every-day/
- https://github.blog/changelog/2026-04-13-fix-merge-conflicts-in-three-clicks-with-copilot-cloud-agent/

### bors

`bors r+` batches approved PRs onto a `staging` branch, CI runs there,
and only on green does master fast-forward. On failure — including
merge conflicts — bors splits the batch and retries each half, giving
O(E·log N) degradation instead of blocking everyone. Conflicted PRs
are reported and dropped; nothing is resolved for you. The public
instance is being phased out in favour of GitHub merge queue, but the
batching semantics remain the reference implementation of
"test the merge before landing it".

- https://bors.tech/
- https://bors.tech/documentation/getting-started/
- https://github.com/leanprover-community/mathlib/blob/master/docs/contribute/bors.md

### Zuul

Dependent pipelines with speculative execution: each change is tested
as if every change ahead of it in the queue had already merged
("optimistic branch prediction" with nearest-non-failing-item
reparenting). A change that fails to merge is dequeued and reported
("Merge failed"), and items behind it are re-tested without it.
Cross-repo dependencies are serialised through shared change queues —
Zuul is the only queue here that manages conflicts spanning
*repositories*, not just branches.

- https://zuul-ci.org/docs/zuul/latest/gating.html
- https://zuul-ci.org/docs/zuul/latest/config/pipeline.html

### Graphite

Stack-aware merge queue: whole stacks queue and merge as a unit with
fast-forward, parallel-CI and batching optimisations (its own
speculative execution). Conflicts still surface as plain rebase
conflicts: the documented remedy is `gt sync` → `gt restack` → resolve
interactively → `gt continue`. No AI resolution ships in the product —
stacking's pitch is conflict *prevention* (smaller, ordered diffs),
not resolution.

- https://graphite.com/docs/graphite-merge-queue
- https://graphite.com/docs/merge-queue-optimizations
- https://graphite.com/docs/merge-pull-requests

The structural observation: queue-time conflict detection and
hunk-time adjudication are the same operation — a merge attempt. A
selector fits naturally on the *client* side of every one of these
(the PR author's fix step, where Copilot's agent already sits), not
inside the queue itself, since queues deliberately hold no mutable
workspace and auto-remove rather than repair.

## 3. jj / sapling conflict models

### Jujutsu — conflicts are data

jj records conflicted states *in commits*: a conflicted file stores an
odd-length ordered list of trees — a start tree plus pairs of
diffs-to-apply — manipulated as an algebra (`A + C − B`, flattened and
simplified in `merge.rs`, cancelling terms removed). Rebase, merge and
backout all succeed *through* conflicts; resolution happens whenever
you feel like it. Conflicts are "materialised" into the working copy
on demand using jj's own marker style (`%%%%%%%` = diff to apply,
`+++++++` = snapshot), and re-parsed back into conflict state on the
next snapshot — you can even partially resolve a conflict by editing
inside markers. `jj resolve --tool X` invokes an external 3-way merge
tool once per conflicted file (`$base $left $right $output`), with
built-in `:ours`/`:theirs` for side-picks.

- https://docs.jj-vcs.dev/latest/conflicts/
- https://docs.jj-vcs.dev/starlight/technical/conflicts/
- https://docs.jj-vcs.dev/latest/working-copy/
- https://man.archlinux.org/man/extra/jujutsu/jj-resolve.1.en

For a selector this is the ideal substrate: adjudication is a library
call against persistent data, not an emergency inside a halted
operation — resolution can be deferred, batched, run in CI, or run by
an agent, and partial resolutions compose. fafo already ships this
integration (`resolve --threeway`, see `docs/jj.md`).

### Sapling — conventional blocking conflicts

Contrary to the "first-class conflicts" framing: Sapling does *not*
store conflicts in commits. Per jj's own comparison doc, "Like most
VCSs, Sapling requires the user to resolve conflicts before
committing" and its auto-rebase fails on conflicts. Its model is the
Mercurial heritage: `sl merge`/`sl rebase` halt on conflict, markers
land in the working copy, `sl resolve --list` enumerates unresolved
files, `sl resolve -m` marks done, `sl resolve --tool` runs an
external merge tool, `sl rebase --continue` resumes.

- https://docs.jj-vcs.dev/latest/sapling-comparison/
- https://sapling-scm.com/docs/introduction/
- https://github.com/facebook/sapling/blob/main/website/docs/introduction/git-cheat-sheet.md

A selector fits Sapling exactly the way it fits git — as a mergetool
invoked inside a halted operation — but gains nothing from the storage
layer: conflicts remain stop-the-world events tied to a working copy.

## 4. Where a learned selector demonstrably fits / fails

### Evidence it fits

- **AutoMerge** is the existence proof: enumerate-then-select resolved
  95.1% of real conflicts that defeated the best deterministic tool,
  with under two candidates tried on average. Selection over a
  bounded space beats both pure-deterministic merge and unbounded
  generation on real data.
- **MergeBERT** shows the learned version of the same shape at
  industrial scale: classification over merge patterns (≈ our flat
  kinds + interleave) at 63–68% precision — which is simultaneously
  proof that learned selection *works* and proof that it needs
  *gates* before it can be trusted unsupervised.
- **`git rerere`** is the degenerate selector already shipping in
  every git install: normalise a conflict (strip labels, drop base,
  sort hunks) to an ID, replay the recorded resolution. Zero risk,
  narrow coverage. A learned selector is rerere generalised from
  exact-match to judgement.
  https://git-scm.com/docs/git-rerere
  https://git-scm.com/docs/rerere
- **jj** makes the fit structural: when conflicts are persistent data
  with a stable tool contract, a selector is just another merge tool
  — and deferred adjudication (resolve later, elsewhere, by an agent)
  is free.
- **Structured-tool residuals**: mergiraf/fuse deliberately emit
  narrower, syntax-aligned conflicts and stop. Selector-on-residuals
  is the composed pipeline — deterministic where determinism works,
  learned where judgement is needed.

### Evidence of the failure boundary

- **Human-edit class is real, not ours alone.** AutoMerge's largest
  failure bucket was "assumption violation" — truth not expressible
  from the two sides. Same class we measured (~9 corpus entries).
  Escalation *is* the correct answer there; no selector over
  enumerated candidates can fix it.
- **Industry's generator answer exists now.** GitHub "Fix with
  Copilot" (Apr 2026) and VS Code AI conflict resolution +
  Agent Merge (2026) resolve conflicts with an unconstrained agent
  whose only gate is CI. That is the competitive frame: generator
  with downstream validation vs selector with upstream gates. The
  selector's selling point is bounded failure — it cannot emit code
  no candidate enumerated; its cost is coverage ceiling.
  https://code.visualstudio.com/docs/sourcecontrol/merge-conflicts
  https://dev.to/techaiwire/vs-code-1136-adds-agent-merge-to-finish-pull-requests-35j8
- **Queues hold no adjudication slot.** Every queue dequeues on
  conflict; resolution lives on the client side. A selector at queue
  time would need a mutable workspace and a requeue path — that's an
  agent-shaped integration (à la Copilot cloud agent), not a
  queue-native one.
- **Sapling/git's halted-operation model** confines a selector to the
  mergetool slot: fits, but only interactively at resolve time.

### Capability matrix

| System | Enumerates candidates? | Learned decision? | Verification of output | Escalation |
|---|---|---|---|---|
| git merge/rerere | no / replay | no | none | markers |
| mergiraf | no (single tree) | no | delete/modify + dup-signature checks | narrower markers |
| spork/JDime/IntelliMerge | no (single tree/graph) | no | structural | markers |
| fuse | no (single file) | no | **re-parse gate** | markers + agent handoff |
| AutoMerge | yes (VSA space) | no (hand ranker) | human accept | next candidate / give up |
| MergeBERT | implicit (patterns) | yes | none reported | none |
| Copilot agent / Agent Merge | no (free generation) | yes | CI/build only | none (pushes anyway) |
| fafo/Jev | yes (flat + composed) | yes | coverage, verify, discard, decisiveness, novelty, composed-file sanity | markers preserved |

### Implications for a software factory

1. The selector's defensible niche is the **bounded adjudicator**:
   everywhere a queue or tool chain wants resolution *without* letting
   a model write code — compliance-sensitive merges, unattended batch
   resolution, rerere-style automation with judgement.
2. Compose behind structured tools: mergiraf/fuse first (deterministic
   wins, narrower residuals), fafo on what survives. Their residual
   markers are already better-scoped hunks.
3. jj is the right target VCS for a factory rollout — first-class
   conflicts turn adjudication into a batch job over commits rather
   than a per-developer interrupt; `--threeway` already speaks the
   contract.
4. Queue-side integration must be agent-shaped (a fixer invoked on
   dequeue, like Copilot's), because no queue exposes a resolution
   hook — and there the selector's pitch is *trust*: same applies as
   an agent would propose, but every apply is drawn from an
   enumerable, auditable candidate set with gates that escalate
   rather than guess.
