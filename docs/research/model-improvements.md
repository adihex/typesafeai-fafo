# Research: improving the Jev merge resolver

Literature pass, 2026-09-18. The core finding: our architecture —
deterministic enumeration + learned selection + calibrated abstention —
is independently validated by the strongest results in the literature.
The improvements below are ordered by expected payoff / effort.

## 1. Deterministic verification, not just Jev verification

The calibrated-judge paper (arXiv:2607.27674) ran generate–validate–retry
solvers and found **"structural correctness must not be delegated to an
LLM"** — their LLM judge accepted 4/5 structurally-invalid resolutions.

Today our only verifier is a Jev noul. Add an executable post-apply check:
parse the resolved file (tree-sitter or the language's own parser),
`git diff --check`, and where a build exists, compile/test the hunk's
scope. Candidate that fails structural checks → rejected regardless of
Jev's verdict. Cheap, deterministic, and it closes the highest-severity
failure mode (plausible-looking broken merges).

## 2. Mergiraf as the deterministic pre-pass

Mergiraf (mergiraf.org) is a tree-sitter merge driver: GumTree three-way
matching → PCS triples → merged tree. It deterministically resolves
"commutative-parent" conflicts (order-independent additions — exactly
the both-additions class Jev adjudicates today), emits *narrower*
conflicts (`--compact`) for the rest, and **keeps markers when unsure —
the same honest-escalation contract**.

Pipeline becomes: `mergiraf solve` → whatever remains is the genuinely
hard residue → Jev adjudicates per hunk. Fewer Jev calls (cost), smaller
hunks (better per-line composition), and semantic pre-verification on
the easy class. Its output can also join the candidate set as
`candidate: mergiraf`.

## 3. Merge-Bench as the real corpus

arXiv:2605.25890 (Schesch & Ernst): **7,938 real conflict hunks from
1,439 repos**, ground truth = the resolution the developer actually
committed. Open harness. Our synthetic fixtures + `dig` corpus are small
and self-graded; Merge-Bench is the standard yardstick — run our
pipeline on it and get a number comparable to published solvers
(best LLMs: <60% resolution; AutoMerge abstains to 36.7% coverage).

## 4. Calibrated abstention instead of hand-set thresholds

Our gates are three independent hand-tuned thresholds (conf/cov/verify
≥ 0.5). The abstention literature offers principled upgrades:

- **UniCR** (arXiv:2509.01455): fuse evidence — Jev confidence, coverage,
  verify dispersion, deterministic-check results — into ONE calibrated
  probability with conformal risk control. Set an explicit error budget
  ("applied resolutions wrong ≤ 5%") and learn the threshold on the
  eval corpus. Distribution-free guarantee vs. our current vibes.
- **CodeRefuser** (arXiv:2605.17029): abstention via execution
  consistency — for us, candidate-verifies-by-running is the strongest
  possible abstention signal.
- **Deferral framework** (arXiv:2605.19369): calibrated confidence +
  abstain + lightweight program analysis on abstained cases — our
  escalate→decompose→second-opinion loop is this shape already; the
  paper supplies the calibration math it's missing.

## 5. Self-consistency voting on borderline hunks

Cheap upgrade inside the existing ask path: for hunks near the
confidence threshold, ask Jev the pick question k times (n=3–5, cheap
small asks) and require majority + agreement margin. Self-consistency
dispersion is UniCR's strongest abstention signal and costs nothing on
confident hunks.

## 6. Mine the corpus for the real candidate taxonomy

MergeBERT (arXiv:2109.00084) reformulated resolution as **classification
over primitive merge patterns extracted from real merge data** —
literally our selector-not-generator framing — and hit 64–69%
precision, ~2× prior tools. The next step for us: classify our `dig`
corpus resolutions by which candidate kind would have matched
(ours/theirs/both-ot/both-to/base/drop/splice/none-of-these). If real
resolutions concentrate on patterns we already enumerate, coverage is
proven; the residual tail tells us which candidates to add (e.g.
MergeBERT's interleaving/mixed patterns) or confirms the honest
escalation floor is fundamental. DeepMerge (TSE 2022) supplies the
prior: "a large majority of resolutions re-arrange text without writing
new code" — enumeration is the right space.

## 7. Decision log → distillation path

LLMergeJ (same paper as #3) trained a 14B resolver with GRPO and beat 3
commercial LLMs. Our decision traces (hunk → candidate set → pick →
verify → outcome) are already trajectory-shaped. The factory-scale end
game: distill Jev's selections on common conflict classes into a cheap
local model, escalate the tail — the two-tier cost structure the A/B
data argues for (plugin costs +60K prompt context on trivial conflicts).

## What NOT to copy

- **Generative resolution** (MergeGen et al.): the LLM-vs-SBSE study
  (arXiv:2605.16646) shows LLM generation excels on imbalanced content
  but truncates/empties on large or non-English inputs — exactly the
  failure mode our contract exists to prevent. Keep Jev a selector.
- **Zero-abstention evaluation**: the calibrated-judge paper shows
  coverage-fair comparisons change rankings (abstaining tools look
  worse than they are). Our evals already score honest escalation as
  correct — keep it, and report coverage alongside precision.

## References

- MergeBERT — arXiv:2109.00084 (classification over merge patterns)
- DeepMerge — IEEE TSE 2022, doi:10.1109/TSE.2022.3183955
- Merge-Bench / LLMergeJ — arXiv:2605.25890 (7,938-hunk corpus, GRPO)
- Calibrated LLM-as-judge merge eval — arXiv:2607.27674
- LLM vs SBSE merge study — arXiv:2605.16646
- UniCR calibrated refusal — arXiv:2509.01455
- CodeRefuser task abstention — arXiv:2605.17029
- Deferral framework for code — arXiv:2605.19369
- Mergiraf — https://mergiraf.org (syntax-aware merge driver)
