import type { ChoiceResponse, NoulResponse, SystemOneResult, Questions } from "@typesafe-ai/sdk";
import { COVERED, NOVEL, PICK, verifyKey } from "./questions.ts";
import type { Candidate, Decision, EscalationReason, ResolveOptions } from "./types.ts";

function isChoice(a: unknown): a is ChoiceResponse {
  return (a as ChoiceResponse)?.type === "choice";
}
function isNoul(a: unknown): a is NoulResponse {
  return (a as NoulResponse)?.type === "noul";
}

/**
 * Turn Jev's fanned-out answers into apply/escalate. Policy lives here, in
 * code — the model supplies judgments, we decide what they permit.
 *
 * The three signals (coverage, winner verification, choice confidence) all
 * hedge around ~0.5 on genuinely ambiguous conflicts, so each alone is a
 * noisy veto. Escalate only when the signals concur: a strong single
 * failure (< STRONG_FLOOR, "confident no"), or two or more weak failures
 * (< their thresholds). A lone borderline signal is treated as hedging.
 * A needs-novel-merge pick always escalates, as does a failed ask.
 */
const STRONG_FLOOR = 0.3;

export function interpret(
  result: SystemOneResult<Questions>,
  candidates: Candidate[],
  opts: ResolveOptions = {},
): Decision {
  const minConfidence = opts.minConfidence ?? 0.5;
  const minCoverage = opts.minCoverage ?? 0.5;
  const minVerify = opts.minVerify ?? 0.5;

  const answers = result.answers;
  const pick = answers[PICK];
  const covered = answers[COVERED];

  const verify: Record<string, number> = {};
  for (const c of candidates) {
    const a = answers[verifyKey(c.kind)];
    if (isNoul(a)) verify[c.kind] = a.noul;
  }

  const detail: Decision["detail"] = {
    verify,
    coverage: isNoul(covered) ? covered.noul : undefined,
  };
  if (isChoice(pick)) {
    detail.picked = pick.choice;
    detail.confidence = pick.confidence;
    detail.probabilities = { ...pick.probabilities };
  }

  const escalate = (reason: Decision["reason"]): Decision => ({ action: "escalate", reason, detail });

  if (!isChoice(pick)) return escalate("ask-failed");
  if (pick.choice === NOVEL) return escalate("novel-merge-needed");

  const winner = candidates.find((c) => c.kind === pick.choice);
  if (!winner) return escalate("ask-failed");

  const cov = detail.coverage;
  const conf = pick.confidence;
  const ver = verify[winner.kind];

  const fails: Array<{ reason: EscalationReason; value: number }> = [];
  if (cov !== undefined && cov < minCoverage) {
    fails.push({ reason: "not-in-candidates", value: cov / minCoverage });
  }
  if (ver !== undefined && ver < minVerify) {
    fails.push({ reason: "verification-failed", value: ver / minVerify });
  }
  if (conf < minConfidence) {
    fails.push({ reason: "low-confidence", value: conf / minConfidence });
  }

  const strong =
    (cov !== undefined && cov < STRONG_FLOOR) ||
    (ver !== undefined && ver < STRONG_FLOOR) ||
    conf < STRONG_FLOOR;

  if (strong || fails.length >= 2) {
    fails.sort((a, b) => a.value - b.value);
    return escalate(fails[0].reason);
  }

  return { action: "apply", candidate: winner, detail };
}
