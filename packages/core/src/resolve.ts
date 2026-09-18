import { enumerateCandidates } from "./candidates.ts";
import { interpret } from "./interpret.ts";
import { parseConflicts } from "./parse.ts";
import { buildHunkRequest } from "./questions.ts";
import type {
  Asker,
  Decision,
  HunkOutcome,
  ResolveOptions,
  ResolveResult,
} from "./types.ts";

function escalateAll(outcomes: HunkOutcome[], reason: Decision["reason"], startIdx = 0) {
  return outcomes.map((o, i) =>
    i >= startIdx && o.decision.action === "apply"
      ? { ...o, decision: { action: "escalate" as const, reason, detail: { verify: {} } } }
      : o,
  );
}

/**
 * Resolve every conflict hunk in `text`: enumerate candidates, ask Jev once
 * per hunk (fanned-out questions), apply winners, leave markers on
 * escalations so a human/LLM still sees them.
 */
export async function resolveText(
  text: string,
  ask: Asker,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const parsed = parseConflicts(text);
  const outcomes: HunkOutcome[] = [];

  for (let i = 0; i < parsed.hunks.length; i++) {
    const hunk = parsed.hunks[i];
    const candidates = enumerateCandidates(hunk);
    const request = buildHunkRequest(parsed, hunk, candidates, opts, opts);
    try {
      const result = await ask(request);
      outcomes.push({
        hunkIndex: i,
        hunk,
        decision: interpret(result, candidates, opts),
        usage: result.usage,
      });
    } catch (e) {
      outcomes.push({
        hunkIndex: i,
        hunk,
        decision: {
          action: "escalate",
          reason: "ask-failed",
          detail: {
            verify: {},
            error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          },
        },
      });
    }
  }

  // Splice winners bottom-up so earlier indices stay valid.
  const lines = [...parsed.lines];
  for (const o of [...outcomes].reverse()) {
    if (o.decision.action !== "apply") continue;
    lines.splice(o.hunk.startLine, o.hunk.endLine - o.hunk.startLine, ...o.decision.candidate!.lines);
  }

  return {
    text: lines.join("\n"),
    outcomes,
    applied: outcomes.filter((o) => o.decision.action === "apply").length,
    escalated: outcomes.filter((o) => o.decision.action === "escalate").length,
  };
}

export { escalateAll as _escalateAll };
