# Judgment-layer service design for a shared Jev resolver

Research for: how fafo/Jev integrates with an actual model inside a software
factory. Scope: N concurrent workers hitting merge conflicts; fafo is a
selector over enumerated candidates (never a generator), with confidence /
coverage / verification gates that either apply a pick or escalate honestly.

Internal evidence referenced: `.auto/diversity-report.md` (corpus-diversity:
76 entries, 26% precision out-of-family vs 65% in-family — the calibration
result this document designs around) and `evals/` agent-surface matrix
(codex/droid/pi/grok: WITH arm outperforms WITHOUT by +0.2 to +0.33 across
all cases; the skill surface fires in most runs, the MCP is reachable but
unevenly invoked).

---

## 1. Service topology for a shared Jev-backed resolver

### Cost model per hunk (measured structure, estimated magnitudes)

One hunk's resolution is a fan-out of `SystemOneRequest` asks
(`packages/core/src/questions.ts`, `resolve.ts`):

- **Base ask** — one Choice + one coverage Noul + one verify Noul per
  candidate, in a single request: state (conflict block, labels, intents) +
  ~5–8 questions. Input ≈ 1–4K tokens (conflict ~0.3–1.5K, per-candidate
  payloads ~150–400 tok each), output ≈ 50–200 tokens (typed judgments).
- **Gate-path adds** — second-opinion on weak conf, head-to-head on tight
  top-2, splice-verify, discard-check, decompose window asks on covFail:
  each ≈ 1 request of similar size.
- **Fast path** (applied on first pass): 1 ask, ~1–4K in / ~0.1K out,
  ~0.5–3 s (network-bound, not compute-bound).
- **Slow path** (escalated or rescued): 3–6 asks, ~6–15K in / ~0.5K out,
  ~3–15 s — every added ask is a sequential RTT.

Observed live: eval runs averaged ~5 min/entry at concurrency 8 on
multi-hunk entries — consistent with ~2–5 s/ask under shared rate limits.

### Three topologies

**(a) Per-worker MCP (status quo).** Each worker spawns `fafo-resolve mcp`
over stdio. Cold start ~1–2 s (npx tsx spawn) amortized per session.
Zero infra, but: no cross-worker dedup (3 workers on the same conflict =
3× token spend), no shared rate budget, auth is per-process env, and
observability fragments into N transcript streams. Confirmed pain in eval:
codex's MCP child didn't inherit `TYPESAFE_API_KEY` — per-worker auth is
the fragile seam.

**(b) Central judgment service.** One service (Streamable HTTP MCP or
REST) fronts all workers. Buys: shared decision cache (§2), one auth
boundary, one concurrency budget that can shape bursts, single-flight
request coalescing for identical in-flight asks, and a single
metrics/calibration feed (§3 needs this — calibration data must pool).
Costs: one deployable, ~10–50 ms LAN hop per ask (negligible vs 0.5–3 s
ask latency), and a trust boundary — workers must not learn each other's
conflict contents (tenant-key the cache, don't log raw code).

**(c) Merge-queue gate.** Resolution moves out of the worker entirely: the
resolver runs once per queued change (GitHub merge queue, bors-ng, Gerrit
submit requirements — the same slot CI occupies). Conflicts are resolved
or escalated *before* a human sees a red merge. Token spend drops from
per-worker to per-PR: a conflicted rebase attempted by 5 workers burns
Jev once. The queue is also the natural place for the honest-escalation
contract — an unresolved hunk blocks the queue entry, exactly like a
failing check. Cost: conflicts discovered mid-work (inside a worker's
private branch) aren't covered — needs (a) or (b) as the inner loop.

**Recommendation:** (b) as the primary service, (c) as the outer gate.
(a) remains the zero-infra fallback for single-worker use — the eval
matrix shows the MCP path works today (grok: live `fafo_scan`/`fafo_resolve`
round-trips) and stdio MCP is the right local transport. The factory
should run one judgment service per blast radius (team/repo family), not
one global — per-family calibration (§3) and cache locality (§2) both
want that shard key.

Per-hunk economics across topologies (N=20 workers × ~30 hunks/day
each ≈ 600 hunks/day):

| | (a) per-worker | (b) central | (c) queue gate |
|---|---|---|---|
| asks/hunk | same | same | same |
| tokens/day (uncached, ~9K in avg) | ~5.4M | ~5.4M | ~2–3M (per-PR not per-worker) |
| dup conflicts (rebase churn ~30–40%) | 3× billed | 1× billed (cache hit) | 1× billed |
| effective tokens/day | ~5.4M | ~3.3–3.8M | ~1.5–2M + inner-loop share |
| latency/hunk | spawn 1–2s + asks | +10–50ms | off critical path entirely |
| auth | N envs | 1 boundary | 1 boundary |

---

## 2. Decision caching / dedup by conflict-content hash

**fafo is the unusual case where exact-match caching is both safe and
sufficient.** General LLM caching defaults to semantic similarity because
open-ended queries rarely repeat verbatim (GPTCache — https://github.com/zilliztech/gptcache;
GPT Semantic Cache reports 61–69% API-call reduction — https://arxiv.org/html/2411.05276v2;
offline-policy analysis — https://arxiv.org/html/2603.03301v1). Merge
conflicts are different: the *same conflict* recurs verbatim across
rebases, cherry-picks, and N workers converging on the same merge — and
"close enough" is NOT safe, because a one-line difference can flip the
correct candidate. Exact hashing is the right cache.

**Key:** `H(normalized-conflict-content | candidate-set | intents |
model | gate-config)`.
- Conflict content: the ours/base/theirs blocks, whitespace-normalized.
- Candidate set: hash of the enumerated lines — the verdict is only
  meaningful relative to the menu it was picked from (a new splice
  candidate must miss the cache, not inherit a stale verdict).
- Intents: ours/theirs intent strings feed the Choice criteria — different
  intents legitimately yield different picks.
- Model + gate-config: model swaps and threshold retunes (the mc60 sweep)
  must invalidate — keying by config gives that for free; no TTL needed.

**Semantics:** cache the *outcome* (pick + gate path), not the verdict's
truth. Jev isn't deterministic; a cached verdict may differ from a fresh
call. Acceptable — the system already treats Jev output as
judgment-probability, and a cached apply carries the same confidence the
gates accepted at write time. Record `conf`/`cov`/`verify` with the entry
for §3's calibration feed and for later "what would the new thresholds
have done" replays (the offline-sweep pattern already proven in
`.auto/diversity-report.md`).

**Coalescing:** concurrent identical asks single-flight (one execution,
shared result — the request-coalescing pattern in
https://github.com/uncle-voh-max/semantic-cache). Rebase storms make this
the common case, not the edge.

**Where:** only the central service (§1b) gets cross-worker dedup; a
per-worker cache still helps within a session (same file re-attempted,
retry loops). Merge-queue gates are naturally dedup'd by PR identity.

---

## 3. Confidence calibration — keeping "escalate honestly" honest at scale

The diverse-corpus result is the motivating failure: gates that meant
"65% likely correct" inside the cv corpus meant 26% outside it — same
reason mix, wrong calibration. Thresholds tuned on one distribution do
not transfer under distribution shift. This is exactly what the
selective-prediction literature formalizes.

**Classical frame.** Chow's reject option (C. Chow, "On optimum
recognition error and reject tradeoff," *IEEE Trans. Inf. Theory*, 1970)
and selective classification (Geifman & El-Yaniv, "Selective
Classification for Deep Neural Networks," arXiv:1705.08500,
https://arxiv.org/abs/1705.08500): the system accepts a prediction only
when confidence clears a threshold; the design knob is the coverage–risk
curve, not a single point. fafo's escalation IS a reject option — the
question is whose guarantee backs the threshold.

**Why heuristic thresholds fail.** Post-hoc calibration (Guo et al.,
"On Calibration of Modern Neural Networks," ICML 2017,
https://arxiv.org/abs/1706.04599 — temperature scaling) fixes
*probability* miscalibration within a distribution; our sweep showed the
deeper problem: on foreign code the score itself stops separating right
from wrong (wrong applies pass at conf 0.67–0.93). No monotone transform
of a non-separating score recovers separation.

**Risk-controlled selection instead.** Conformal risk control
(Angelopoulos & Bates, "Conformal Risk Control," arXiv:2208.02814,
https://arxiv.org/abs/2208.02814; "Learn then Test," arXiv:2110.01052)
flips the procedure: pick the operating point — threshold, gate
composition, quorum rule — on a labeled calibration set so the
*expected risk among accepted hunks* stays ≤ α with finite-sample
guarantees. The eval corpora (corpus-v2, corpus-diverse) are literally
the calibration sets this machinery wants. Recent work targets exactly
our shape: selective conformal risk control with e-values (SCoRE,
https://arxiv.org/html/2603.24704), conformal abstention for LLMs
(https://arxiv.org/html/2405.01563v1), and confidence-interval calibration
of arbitrary uncertainty scores into risk-controlled answering (CIC,
https://arxiv.org/html/2607.04430v1); per-instance abstention policies
(CAP, https://proceedings.mlr.press/v304/tayebati26a.html) adapt the risk
level per input instead of a global τ.

**The catch conformal already knows.** Exchangeability is required —
and corpus-v2→diverse *is* the non-exchangeable jump. So:

1. **Calibrate per family, online.** Each human-resolved hunk is a free
   label. Feed outcomes into a running calibration stream per repo
   family (the §1b service is where the labels pool); re-derive the
   operating point under conformal risk control as the stream grows.
   "Escalate honestly" stays calibrated because the guarantee tracks the
   same-family hunk stream — drift shows up as rising escalation, which
   is the honest behavior.
2. **Thresholds on features, not just conf.** Our misses were
   quorum-slips — one weak signal (cov 0.36–0.61) excused by two strong
   ones. Fit isotonic/logistic calibration over (conf, cov, verify,
   margin, discard-audit) → P(correct), then threshold calibrated risk.
   The discard-audit result (verify 0.41–0.58 on wrong side-picks) is a
   ready-made feature.
3. **Distribution-free fallback.** Where no calibration stream exists
   (new repo family), default conservative — the diverse corpus showed
   coverage collapses slower than risk (68% escalate) — that's the safe
   direction.

---

## 4. Prior art: selector-not-generator architectures

The pattern — enumerate candidates mechanically, let a model judge —
has deep precedent, and each neighbor contributes a design constraint
fafo already encodes or should adopt.

**Verification beats generation.** Cobbe et al., "Training Verifiers to
Solve Math Word Problems" (arXiv:2110.14168,
https://arxiv.org/abs/2110.14168): sampling N solutions and picking the
verifier's top beat a stronger generator — *verification is an easier
task than generation, and selection gives optionality*. That's fafo's
core bet: Jev never writes the merge, it ranks code-enumerated options.
Lightman et al., "Let's Verify Step by Step" (arXiv:2305.20050,
https://arxiv.org/abs/2305.20050) extends it to per-step verification
(PRMs) — the analogue of per-hunk/per-window judgment, and evidence that
finer-grained verification outperforms outcome-only signals (cf. our
decompose windows). AlphaCode (Li et al., *Science* 2022,
arXiv:2203.07814) industrialized generate→filter→cluster→select at scale
— with the asymmetry inverted: generation is cheap there, candidates are
cheap here and judgment is the spend.

**LLM-as-judge.** Zheng et al., "Judging LLM-as-a-Judge with MT-Bench"
(arXiv:2306.05685) plus the taxonomy survey "From Generation to
Judgment" (arXiv:2411.16594, https://arxiv.org/html/2411.16594v4):
selection-based judgment — pick from a candidate set — is a distinct,
well-supported judgment mode (vs scoring/ranking free text). Documented
judge biases — position, verbosity, self-preference — are mitigated
structurally in fafo: candidates are code-defined lines, so there's no
generated text to prefer; the EL-DGR result ("When the Judge Should Not
Decide," https://arxiv.org/html/2608.07813) is the closest match to our
gate design: the judge ranks *within* certified strata and can never
promote an uncertified candidate — exactly fafo's non-compensatory
quorum (`fails ≥ 2` escalate, `STRONG_FLOOR` veto). Where EL-DGR derives
certificates mechanically, fafo's strata are gate outcomes — same
admissibility-before-preference architecture.

**Rerankers are the engineering template.** Pointwise/listwise LLM
reranking is the production ancestor of judge-selection: JudgeRank
(arXiv:2411.00142, https://arxiv.org/html/2411.00142v1) shows reasoning-
first pointwise judging beats direct scoring on hard retrieval; listwise
approaches (LRL; Setwise prompting, Zhuang et al.) exist specifically to
cut LLM inference calls per ranking — the same cost pressure behind
fafo's one-request-fanned questions (Choice + coverage + N verifies in
a single ask is a listwise-reranker-shaped token optimization). The
cross-encoder lineage (BGE et al.) matters for §1: a small dedicated
reranker is the fallback if Jev ask latency ever dominates the merge
loop.

**Judges need anchoring and monitoring.** Netflix's LLM-judge lifecycle
(https://netflixtechblog.medium.com/the-lifecycle-of-llm-as-a-judge-building-aligning-and-monitoring-at-scale-c95bd8283508):
a judge never operates alone — human-labeled anchors, drift monitoring,
judge-as-gate deployment. Our calibration drift finding is their drift
chapter: monitor P(apply is correct) against human outcomes and treat
judge degradation as an operational event, not a modeling one.

**Constrained output is the cheap reliability win.** Structured
decoding — JSON-schema/grammar-constrained generation (Outlines;
OpenAI structured outputs) — turns a judge's freeform verdict into a
typed object. TypeSafe's `systemOne` typed judgments are the productized
form: the request schema *is* the constrained output contract (Choice +
Nouls), which is why parse failures are ~0 across the eval matrix.

**Where fafo is novel vs. the literature.** Judges elsewhere pick among
model-generated samples (whose failure mode is homogeneity); fafo's
menu is mechanically enumerated, so the failure mode is *coverage* —
the right answer can be absent (novel-merge-needed, our dominant miss).
That's the inverse problem and it inverts the fix: the literature scales
N samples; fafo must expand the candidate generator (edited-variant
candidates — the identified ~9-entry human-edit floor).

---

## Open questions for the next slice

- Does dedup change verdict trust? A cached verdict skips the fresh
  gate path — should cache hits bypass or re-run cheap gates?
- Calibration labels: which human signals count as ground truth at
  scale (accepted applies, edited-after-apply, manual resolutions)?
- MCP multi-tenancy: standard practice for per-tenant auth/rate-limits
  on Streamable HTTP servers is still thin — worth a spike.
