# Factory merge-layer architectures

How do agent fleets serialize parallel work, how often do parallel committers
actually collide, and where should a Jev-style adjudicator sit in the merge
pipeline? This is the merge-layer half of "how does fafo integrate with an
actual model inside a software factory."

Scope note: "conflict" throughout means a *textual* conflict — git cannot
auto-merge and emits markers. Semantic conflicts (both sides merge cleanly,
the combination is wrong) are the queue's problem (CI), not fafo's — but they
motivate the same architecture: serialize, test the combination, escalate
honestly.

## 1. How parallel work gets serialized

Every scaled system converges on the same shape: **one ordered integration
spine, workers enqueue and stop, a gate tests the combination that will
actually land, failures route back to a specific owner.** The differences are
where the spine lives and who does the conflict work.

### 1.1 Queue-gate serialization — bors → Zuul → GitHub merge queue → GitLab merge trains

The lineage starts with bors (Rust, 2014+): the "Not Rocket Science Rule" —
*automatically test all code before it hits master* — because CI on each PR in
isolation misses **semantic conflicts**: two changes that each pass but break
in combination. Bors batches approved PRs, merges them speculatively, tests the
combined state, and only then pushes to main.
<https://bors.tech/essay/2017/02/02/pitch/>
(bors-ng's public instance has since been wound down in favour of GitHub merge
queues — the pattern won.)

Zuul (OpenStack's gating system) generalized this into a **dependent pipeline
manager**: speculative execution assumes every queued change succeeds and tests
them in parallel in order; on a failure the change is dequeued and everything
behind it re-tests without it. Best case: N changes land in parallel. Worst
case: serial testing. <https://zuul-ci.org/docs/zuul/latest/gating.html>

GitHub merge queue is the productized version: a temporary `merge_group`
branch = base + queued PRs ahead + yours; required checks run against that
exact state; PRs that conflict with queue-mates are **automatically detected
and removed, with the author notified**. Build concurrency is configurable
1–100. <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue>

GitHub's own internal history is the best published failure-mode data on the
alternatives. Before merge queue they ran "trains" — a special PR grouping
~15 passenger PRs with a human **conductor** who "handled conflicts that
arose." Trains "frequently derailed" on conflicts; developers could wait **8+
hours** aboard a train only to be ejected for a conflict between two other
PRs. Merge queue replaced it; it now merges hundreds of PRs/day, 2,500/month
into the monorepo from 500+ engineers, average wait time −33%, and it shipped
30,000+ PRs with 4.5M CI runs before GA. The stated design principle:
*"the throughput of the overall system should be favored over fairness to an
individual pull request."*
<https://github.blog/engineering/engineering-principles/how-github-uses-merge-queue-to-ship-hundreds-of-changes-every-day/>

GitLab merge trains are the same idea on a different host — a FIFO queue of
pipelines each run against the merge result of everything ahead; a failed
pipeline drops its MR and re-forms the train.
<https://docs.gitlab.com/ci/pipelines/merge_trains/>

**Adjudication point in all of these:** none — they detect conflicts and
*reject*. The human author is the adjudicator. That is the gap fafo fills.

### 1.2 Server-side landing — Meta's Landcastle/Mononoke, Google's Piper submit

Meta and Google don't use PR queues; they put the serialization inside the
VCS itself.

Meta: developers submit stacks of diffs to Phabricator; after review, "Ship
It" hands the diff to **Landcastle**, the landing service — per the F8 dev-infra
talk, *"it is not OK at Facebook to land a diff without using Landcastle"* —
developers do not push to master at all. Landcastle lands the diff server-side,
re-runs tests, and files "push-blocking tasks" back to the author on failure.
The same talk records why server-side: the **push-pull-rebase bottleneck** —
rebase-and-push races get worse as commit rate climbs — was eliminated by
moving the rebase server-side onto push. 2015 scale: >1M SCM commands/day,
>100k commits/week.
<https://gregoryszorc.com/blog/2015/03/28/notes-from-facebook's-developer-infrastructure-at-scale-f8-talk/>
<https://developers.facebook.com/blog/post/2022/11/15/meta-developers-workflow-exploring-tools-used-to-code/>

Today the server is **Mononoke** (Sapling's server-side component), built "to
scale up to accepting thousands of commits every hour across millions of
files," and the client is Sapling with stacks as the first-class workflow.
<https://github.com/facebook/sapling>
Meta's 2025 branching post is also relevant: even they concluded that
*mergeable* branching must be scoped to directories — full-repo merges don't
scale because multi-parent merge commits widen the commit graph.
<https://engineering.fb.com/2025/10/16/developer-tools/branching-in-a-sapling-monorepo/>

Google: Piper + CitC (cloud workspaces overlaid on the repo) with trunk-based
development and essentially no personal branches — conflicts are mostly
absorbed at `sync`/submit time inside the VCS. Scale (CACM 2016): ~1B lines,
~86TB, 9M files, ~25k engineers producing ~16k human changes/day plus ~24k
automated.
<https://dl.acm.org/doi/10.1145/2854146>
<https://en.wikipedia.org/wiki/Piper_(source_control_system)>

**Adjudication point:** the VCS submit path — as close to materialization as
possible, with the author's client pulled in only when the merge fails.

### 1.3 Stacked-diffs ordering — Phabricator `arc`, Graphite `gt`, Aviator `av`

Stacking serializes *within* a worker, not across the fleet: dependent changes
become a chain of small diffs landed bottom-up. The merge-relevant mechanics:

- `arc land` / `arc land stack` lands the bottom diff(s) and rebases the
  rest — cascading restack is the primitive.
  <https://secure.phabricator.com/T2493>
- Graphite (`gt`) brings the Phabricator experience to GitHub: `gt create` /
  `gt submit`, restack on parent changes.
  <https://graphite.com/docs/evaluating-tools>
- Aviator (`av`) pairs a stacked-PR CLI with a **stack-aware MergeQueue** —
  `av pr --queue` enqueues the whole stack; `av sync` propagates a conflict
  resolution in a parent branch down to all children ("conflict resolutions
  are seamlessly propagated to child branches").
  <https://www.aviator.co/stacked-prs>

Important consequence for fleets: stacks are per-producer. They reduce a
worker's *own* merge surface (small diffs, ordered lands, resolution reuse
downstack) but say nothing about conflicts *between* producers — which the
co-active data in §2 shows is the dominant fleet case.

### 1.4 Working-tree coalescence — GitButler virtual branches

GitButler inverts the direction: instead of N branches merged at the end,
multiple virtual branches are applied to **one working directory at once**,
each hunk earmarked to a lane. The claimed invariant: *"since you're starting
from changes in a single working directory, you can be sure that all branches
you create from it will merge cleanly — you're starting from the merge
product."* Conflicts can't exist because the merged state is authored first
and decomposed later.
<https://docs.gitbutler.com/features/branch-management/virtual-branches>
<https://blog.gitbutler.com/building-virtual-branches>

Fleet mapping: this is the single-writer case. It works when one brain (a
human, or one orchestrating agent) produces all the content; it doesn't
address genuinely concurrent producers.

### 1.5 Mass-change sharding — Google Rosie

Rosie's answer to conflicts-at-scale is to **refuse to create the conflict**:
a large-scale change is split into per-owner/per-project shards small enough
to review and land independently (rule of thumb: automate once an edit touches
>500 locations). The observation driving it: the largest atomic change
possible *shrinks* as the codebase and committer count grow — a mega-change
"would always have merge conflicts."
<https://abseil.io/resources/swe-book/html/ch22.html>

Fleet mapping: task partitioning is the first conflict-control lever — but it
only reduces the rate; §2 shows what remains.

### 1.6 The agent-fleet generation — the queue pattern, re-derived locally

The same architecture is being independently re-built for coding agents at
local/small-team scale:

- **mergetrain** — "Parallel agents need a serial integration spine." Local
  SQLite queue; agents commit and enqueue; one lease-fenced runner assembles a
  FIFO train in a throwaway worktree, validates the exact combined train,
  pushes atomically. Explicitly: agents that push, race.
  <https://github.com/yongjip/mergetrain>
- **claude-code-merge-queue** — local FIFO `land` command for parallel Claude
  Code worktrees; a pre-push hook rejects direct pushes to the integration
  branch; human-only `promote` step.
  <https://github.com/funador/claude-code-merge-queue>
- **agent-semaphore** — adds the layer the others lack: intent-carrying claims
  on file scopes, write-time warnings, a `git merge-tree` "conflict radar"
  between live worktrees, then a test-gated landing queue.
  <https://github.com/alwh1te/agent-semaphore>
- **agent-merge-batch-protocol** — a protocol for landing 5–8 ready
  independent agent PRs as one batch instead of letting them contend on
  `main`.
  <https://github.com/jremick/agent-merge-batch-protocol>
- **aipatternbook.com/merge-queue** — the pattern catalogued as a first-class
  agentic-coding pattern: "CI verified them in parallel universes; the
  mainline is one universe." <https://aipatternbook.com/merge-queue>

And at the VCS-driver layer, **mergiraf** (syntax-aware merge driver) is the
closest existing relative to fafo's contract — and independently arrived at
the same honesty rule: *"err on the side of caution and retain conflict
markers in the file when encountering suspicious cases."*
<https://mergiraf.org/>

### Taxonomy summary

| Mechanism | Serialization point | Conflict discovery | Conflict adjudication | Escalation target |
|---|---|---|---|---|
| Merge queue / trains | Temp merge_group branch in CI | At group formation | **None — eject + notify** | PR author |
| Zuul dependent pipeline | Speculative ordered window | At dequeue/retest | None — eject | Change owner |
| Meta Landcastle | Landing service (only path in) | Server-side rebase | Author pulled in via push-blocking task | Diff author |
| Google Piper submit | VCS submit/sync path | At submit | Author in CitC workspace | Author |
| Stacked diffs | Within-producer ordering | At restack | Author; resolution propagates downstack | Same producer |
| GitButler vbranches | Pre-merged working tree | Never — merged first | The single writer | n/a |
| Rosie sharding | Task partitioning upstream | Minimized a priori | Per-shard owners | Shard author |
| Agent local queues | Local FIFO land runner | At land time | **None — test gate rejects** | Enqueueing agent |

Every entry has a serialization spine; almost none has an adjudication brain.
That empty column is fafo's market.

## 2. Measured conflict rates

### Human baseline

- **~10–20% of merge attempts conflict** — the canonical figure cited across
  the literature (Ghiotto et al., TSE 2020; 2,731 OSS Java repos).
  <https://leomurta.github.io/papers/ghiotto2018.pdf>
- **19.32%** of 36,122 merge commits across 143 OSS projects contained
  conflicts; **75.23%** of those required a developer to reason about program
  logic to resolve (not just pick a side). Code associated with a merge
  conflict is **2×** as likely to contain a bug; when the conflict is
  *semantic*, **26×**. (Mahmoudi, Nadi, Tsantalis — EMSE.)
  <https://stairs.ics.uci.edu/papers/2020/emperical_MC.pdf>

### Agent PRs — AgenticFlict (AIware'26)

The first large-scale measurement of agent-authored PR conflicts
(arXiv:2604.03551; 142,652 agentic PRs from AIDev across 59,412 repos,
107,026 simulated merges):

- **27.67% conflict rate overall** — ~1.4–2.8× the human baseline.
- **Per-agent:** Copilot 15.24%, Cursor 19.75%, Devin 22.85%, Claude Code
  25.93%, OpenAI Codex 31.85% (95% CIs non-overlapping at the extremes — the
  agent product itself is a conflict-rate variable).
- **Severity per conflicting PR:** mean 4.36 conflicting files (median 2),
  mean 11.36 conflict regions, ~540 conflict lines — heavy-tailed; most are
  small but the tail is long.
- Watanabe et al. (2025): merge conflicts already account for >1.1% of
  agentic-PR rejections; openai/codex PR #612 was abandoned over an
  unresolvable conflict.
- Secondary analysis reported by agent-semaphore over co-active PR pairs in
  the same dataset: **19.8% intra-agent vs 41.7% cross-agent** — the closest
  published thing to a "parallelism multiplier": conflicts roughly double when
  concurrent work comes from horizontally-unaware peers. (Unreviewed analysis;
  cite with that caveat.)
  <https://arxiv.org/html/2604.03551v2>
  <https://github.com/alwh1te/agent-semaphore>

### As a function of parallel committers — what exists

No published clean f(N) curve ("conflict rate vs N concurrent committers").
The defensible statements:

- **#committers on the merge is among the strongest predictors**, alongside
  changed files/commits/lines — 182,273 merge scenarios, 80 projects (Vale et
  al., JSERD 2021). Branch lifetime and developer-overlap between branches
  both correlate positively with conflicts.
  <https://doi.org/10.5753/jserd.2021.1911>
- More developers, commits, and changed files in a contribution → more likely
  to conflict; longer-lived contributions → more likely (73,504 merges, Borba
  et al. IST 2020). <https://pauloborba.cin.ufpe.br/publication/2020understanding_predictive_factors_for_merge_conflicts/2020ISTPredictiveFactorsForMergeConflicts.pdf>
- Conflict prediction from git features alone tops out around precision
  .48–.63 / recall .68–.83 (267,657 scenarios; Owhadi-Kareshk et al.
  ICSE-SEIP'19) — prediction helps triage, not prevention.
  <https://arxiv.org/abs/1907.06274>
- Direction of travel: AI assistants increase commit frequency ~13.55% (Cui et
  al. 2026, cited in AgenticFlict) — more parallel committers is the trend,
  not a phase.
- Landing-latency observation (Matthew Berman's fleet, validated in
  agent-merge-batch-protocol): 5–8 ready agent PRs contending on `main` with
  ~2-min CI → the tail PR takes an hour+ in stale-branch/rebase/retry loops.
  Serialization isn't optional even at single-digit agent counts.
  <https://github.com/jremick/agent-merge-batch-protocol>

### Local corpus anchor

Our own PR-corpus run sits consistently with the agent-fleet picture: 45/77
open PRs on a busy monorepo carry conflicts (58% — cumulative staleness, not
instantaneous parallelism; stale mega-PRs dominate), 2,943 conflict hunks,
and Jev currently escalates ~57% of hunks. Fleets will live in the
high-conflict regime the AgenticFlict data predicts.

## 3. Where the adjudication point should live

Options: (a) per-worker skill, (b) central merge service, (c) queue gate,
(d) VCS-layer hook. Derive the answer from what the fafo contract needs:

**Requirements the contract imposes**

1. **Both intents must be present.** `oursIntent`/`theirsIntent` measurably
   change selection quality in our evals. Only the orchestrator knows what
   each worker was *trying* to do — neither side's blob contains it.
2. **Adjudication must run on the merge that will actually land.** A verdict
   computed against a speculative state is stale by land time — the same
   reason merge queues test the `merge_group`, not the PR head.
3. **The point must have authority to block.** "Escalate honestly" only works
   if someone can refuse the land and keep markers where markers belong.
4. **Whole-composed-file visibility.** The sanity pass exists because
   per-hunk decisions are independent — 14.8% of applied files carried
   cross-hunk contradictions. Any adjudication point that only sees one hunk,
   one file-region, or one side of the merge cannot run it.
5. **A structured verdict must flow somewhere.** Escalation carries reason +
   candidates + confidence + coverage — it only has value if there's a router
   downstream.
6. **Cost amortization.** Jev asks cost tokens (~44M for 2,943 hunks in v4).
   Running adjudication speculatively at every rebase multiplies spend; run it
   once, at the authoritative merge.

**Evaluation**

- **Per-worker skill** (`fafo-resolve` via SKILL.md in each worker): right for
  *pre-flight* — a worker rebasing onto current main and clearing cheap
  conflicts before enqueueing saves the gate work. But it can't be the
  authoritative layer: "theirs" is a moving target at pre-flight time; N
  workers × M speculative merges duplicates asks; no access to the other
  worker's intent; no authority over what lands. Keep it, demote it.
- **VCS-layer hook** (merge driver / mergetool — our `install-mergetool`
  surface): correct locality — git invokes it at materialization — but wrong
  context. A driver sees three blobs: no intents, no verdict channel back, and
  git drivers are per-file, which structurally cannot run the composed-file
  gate. The mergetool shape also assumes a human at the terminal. Keep it as
  the human-facing fallback path, not the factory path.
- **Queue gate / central merge service** (Landcastle-, merge-queue-, or
  mergetrain-shaped): satisfies all six requirements. It is where the merge is
  materially committed, where both producers' manifests are known, where the
  block authority already exists (queues already eject; Landcastle already
  files tasks back), and where a verdict can be routed. Every scaled system
  built the spine and left this seat empty.

**Answer: the adjudicator lives inside the gate, as a stage between
conflict-detection and land.**

```
enqueue → merge-tree (conflict?) → enumerate candidates → Jev selects/verifies
       → compose → composed-file sanity → land | escalate-with-verdict
```

This is also the only architecture consistent with "Jev never writes code":
the gate's job is *deciding*, not generating — generation stays with workers
(§4). The per-worker skill and mergetool hook remain valid as degraded modes
(solo dev, human in the loop) — they share the core and differ only in which
intents and authority are present.

## 4. Escalation routing — who gets the hunk

An escalation is a **work order, not a failure**. It should carry: the verdict
(reason, candidates tried, confidence, coverage), both sides' intents, the
hunk and file context. The routing question is who can act on it.

Precedents already route this way: GitHub's queue ejects a conflicting PR and
notifies **the author**; Meta files a push-blocking task to **the author**;
GitHub's own pre-queue system used a human conductor as the manual
adjudicator. Nobody routes escalations to "the system."

Recommended cascade:

1. **Owning worker — generative retry with verdict attached.** Cheapest,
   intent-richest target, and the only one that can produce *new code*
   honestly. Crucially this preserves the contract: the worker's retry output
   becomes a **new enumerated candidate** that re-enters the normal
   select/verify path — Jev never generates, it judges the worker's
   generation. This is exactly the `needs-novel-merge` case: the candidate set
   was honest that none fit.
2. **Stronger model — capability-bound escalations.** When the selector
   itself was unsure (`low-confidence`) or the worker's domain reasoning is
   the bottleneck, a higher-tier model is the next-cheapest step. Our re-ask
   data supports paying for this deliberately rather than re-rolling the same
   tier: 11/34 frontier hunks flip on re-ask — same-tier retries are
   coin-flips, not escalations.
3. **Human — terminal.** Semantic conflicts carry ~26× bug density; whatever
   survives model escalation must never be force-applied. But the human
   receives the full verdict + both intents + the candidate menu — not bare
   markers — which attacks the 75.23%-of-cases "reconstruct the program
   logic" cost directly.

By escalation reason:

| Reason | Route | Why |
|---|---|---|
| `not-in-candidates`, `novel-merge-needed` | Owning worker (generative retry) | Only the owner knows intent; output becomes a new candidate |
| `verification-failed` | Owning worker, verifier objection attached | It can produce a provably-consistent variant |
| `low-confidence` | Stronger model | Same-tier retry is a coin-flip; the gate was unsure, not the candidate set |
| `invalid-composition` | Code-level fix, no model | A buggy candidate generator can't be fixed by asking harder |
| `discards-work` | Owning worker | Its change was dropped — it must re-express, not retry blindly |
| survives both | Human with full verdict | Terminal; never silent-merge |

Hard rule, backed by the 26× number: **the worst outcome is not the conflict,
it's the quiet bad resolution.** Any routing scheme that silently merges an
escalation has failed worse than escalating did.

## 5. What the factory needs from fafo that doesn't exist yet

- **A service-shaped interface.** `fafo-resolve mcp` is per-session; a gate
  needs a batch/service call: (ours, theirs, base, oursIntent, theirsIntent)
  → verdict. Same pipeline, different adapter.
- **The verdict as the routing payload.** Escalation reason + candidates +
  confidence/coverage + composed-file findings is already the schema — it
  needs to be the documented contract for the worker-retry loop.
- **Composed-file sanity at gate level.** The veto belongs where the whole
  composed file is known — which is exactly the argument for gate placement.
- **A conflict radar.** agent-semaphore's merge-tree-between-live-worktrees
  idea is a cheap pre-pass for the fleet: predict collisions at write time,
  adjudicate at land time.
- **Per-agent conflict-rate telemetry.** AgenticFlict shows agent identity is
  a conflict-rate variable (15%–32%); a factory should measure its own
  per-worker and per-pair rates and feed them into task partitioning (Rosie's
  lever) before they hit the gate.

## Sources

- GitHub merge queue docs — <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue>
- How GitHub uses merge queue — <https://github.blog/engineering/engineering-principles/how-github-uses-merge-queue-to-ship-hundreds-of-changes-every-day/>
- GitHub merge queue GA — <https://github.blog/news-insights/product-news/github-merge-queue-is-generally-available/>
- GitLab merge trains — <https://docs.gitlab.com/ci/pipelines/merge_trains/>
- Bors, "About semantic conflicts" — <https://bors.tech/essay/2017/02/02/pitch/>
- Zuul project gating — <https://zuul-ci.org/docs/zuul/latest/gating.html>
- GitButler virtual branches — <https://docs.gitbutler.com/features/branch-management/virtual-branches>, <https://blog.gitbutler.com/building-virtual-branches>
- Graphite vs stacking tools — <https://graphite.com/docs/evaluating-tools>
- Aviator stacked PRs + MergeQueue — <https://www.aviator.co/stacked-prs>
- Pragmatic Engineer, stacked diffs — <https://newsletter.pragmaticengineer.com/p/stacked-diffs>
- Phabricator `arc land stack` — <https://secure.phabricator.com/T2493>
- Potvin & Levenberg, CACM 2016 — <https://dl.acm.org/doi/10.1145/2854146>
- Piper overview — <https://en.wikipedia.org/wiki/Piper_(source_control_system)>
- SWE at Google, ch. 22 LSC/Rosie — <https://abseil.io/resources/swe-book/html/ch22.html>
- Meta dev workflow / Landcastle — <https://developers.facebook.com/blog/post/2022/11/15/meta-developers-workflow-exploring-tools-used-to-code/>
- Szorc, F8 dev-infra notes (server-side rebase, >100k commits/week) — <https://gregoryszorc.com/blog/2015/03/28/notes-from-facebook's-developer-infrastructure-at-scale-f8-talk/>
- Sapling/Mononoke — <https://github.com/facebook/sapling>
- Branching in a Sapling monorepo — <https://engineering.fb.com/2025/10/16/developer-tools/branching-in-a-sapling-monorepo/>
- Ghiotto et al., On the Nature of Merge Conflicts (TSE 2020) — <https://leomurta.github.io/papers/ghiotto2018.pdf>
- Mahmoudi et al., merge conflicts & software quality (EMSE) — <https://stairs.ics.uci.edu/papers/2020/emperical_MC.pdf>
- Owhadi-Kareshk et al., Predicting Merge Conflicts — <https://arxiv.org/abs/1907.06274>
- Vale et al., attributes raising conflict occurrence (JSERD 2021) — <https://doi.org/10.5753/jserd.2021.1911>
- Borba et al., predictive factors for merge conflicts (IST 2020) — <https://pauloborba.cin.ufpe.br/publication/2020understanding_predictive_factors_for_merge_conflicts/2020ISTPredictiveFactorsForMergeConflicts.pdf>
- AgenticFlict (AIware'26) — <https://arxiv.org/html/2604.03551v2>, dataset <https://zenodo.org/records/19396917>
- mergetrain — <https://github.com/yongjip/mergetrain>
- claude-code-merge-queue — <https://github.com/funador/claude-code-merge-queue>
- agent-semaphore — <https://github.com/alwh1te/agent-semaphore>
- agent-merge-batch-protocol — <https://github.com/jremick/agent-merge-batch-protocol>
- Agentic patterns: merge queue — <https://aipatternbook.com/merge-queue>
- mergiraf (syntax-aware merge driver) — <https://mergiraf.org/>
