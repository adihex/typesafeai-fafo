import type { ChoiceResponse, NoulResponse, SystemOneResult, Questions } from "@typesafe-ai/sdk";
import { COVERED, NOVEL, PICK, verifyKey } from "./questions.ts";
import type { Candidate, Decision, ResolveOptions } from "./types.ts";

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
 * Escalate when: coverage fails (answer isn't in the set), the model itself
 * picked needs-novel-merge, the winner fails dual-intent verification, or
 * choice confidence is under threshold.
 */
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

  if (isNoul(covered) && covered.noul < minCoverage) {
    return escalate("not-in-candidates");
  }
  if (!isChoice(pick)) return escalate("ask-failed");
  if (pick.choice === NOVEL) return escalate("novel-merge-needed");

  const winner = candidates.find((c) => c.kind === pick.choice);
  if (!winner) return escalate("ask-failed");

  if (verify[winner.kind] !== undefined && verify[winner.kind] < minVerify) {
    return escalate("verification-failed");
  }
  if (pick.confidence < minConfidence) return escalate("low-confidence");

  return { action: "apply", candidate: winner, detail };
}
