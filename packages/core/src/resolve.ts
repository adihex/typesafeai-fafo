import { enumerateCandidates } from "./candidates.ts";
import { decomposeHunk, type Element } from "./decompose.ts";
import { interpret } from "./interpret.ts";
import { parseConflicts } from "./parse.ts";
import { buildHunkRequest, buildSpliceVerifyRequest, NOVEL, VERIFY_SPLICED } from "./questions.ts";
import type {
  Asker,
  Candidate,
  ConflictHunk,
  Decision,
  HunkOutcome,
  ParsedConflicts,
  ResolveOptions,
  ResolveResult,
  WindowTrace,
} from "./types.ts";

function escalateAll(outcomes: HunkOutcome[], reason: Decision["reason"], startIdx = 0) {
  return outcomes.map((o, i) =>
    i >= startIdx && o.decision.action === "apply"
      ? { ...o, decision: { action: "escalate" as const, reason, detail: { verify: {} } } }
      : o,
  );
}

const SITUATION_SUFFIX =
  " The marked region is one window of a larger conflict — neighboring" +
  " windows are decided separately, so resolve THIS region only. Lines" +
  " outside the markers are context shared by both versions.";

interface WindowAskResult {
  decision: Decision;
  usage?: { input_tokens: number; output_tokens: number };
}

function addUsage(
  a: { input_tokens: number; output_tokens: number } | undefined,
  b: { input_tokens: number; output_tokens: number } | undefined,
) {
  if (!a) return b;
  if (!b) return a;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

/**
 * Context for one window: what has been resolved so far (anchors + applied
 * windows) before it, upcoming anchors after it, plus a few lines of real
 * file context outside the conflict.
 */
function windowContext(
  parsed: ParsedConflicts,
  hunk: ConflictHunk,
  elements: Element[],
  index: number,
  resolvedSoFar: string[],
): { contextBefore: string[]; contextAfter: string[] } {
  const fileBefore = parsed.lines.slice(Math.max(0, hunk.startLine - 5), hunk.startLine);
  const fileAfter = parsed.lines.slice(hunk.endLine, hunk.endLine + 5);
  const contextBefore = [...fileBefore, ...resolvedSoFar].slice(-15);

  const afterAnchors: string[] = [];
  for (let i = index + 1; i < elements.length && afterAnchors.length < 15; i++) {
    const e = elements[i];
    if (e.kind === "anchor") afterAnchors.push(...e.lines);
  }
  return {
    contextBefore,
    contextAfter: [...afterAnchors.slice(0, 15), ...fileAfter].slice(0, 15),
  };
}

/**
 * Finest granularity first; coarsen only when the window count would blow
 * the ask budget. Returns null when no granularity produces a useful split.
 */
function decomposeAdaptive(
  hunk: ConflictHunk,
  maxWindows: number,
): Element[] | null {
  for (const minAnchor of [1, 3, 8]) {
    const { elements, windows } = decomposeHunk(hunk, minAnchor);
    if (windows === 0 || windows > maxWindows) continue;
    const ws = elements.filter((e): e is Element & { kind: "window" } => e.kind === "window");
    // A single window spanning the whole hunk is the same question again.
    if (
      ws.length === 1 &&
      ws[0].ours.length === hunk.ours.length &&
      ws[0].theirs.length === hunk.theirs.length
    ) {
      continue;
    }
    return elements;
  }
  return null;
}

/**
 * Decompose-and-retry for an escalated hunk. Aligns ours/theirs(/base) into
 * anchors + windows, asks Jev per window, and splices the winners. Returns
 * null when the hunk can't usefully decompose (no anchors, one whole-hunk
 * window, or too many windows), so the caller keeps the original verdict.
 */
async function resolveHunkDecomposed(
  parsed: ParsedConflicts,
  hunk: ConflictHunk,
  ask: Asker,
  opts: ResolveOptions,
  wholeHunkReason: Decision["reason"],
): Promise<{ decision: Decision; usage?: WindowAskResult["usage"] } | null> {
  const elements = decomposeAdaptive(hunk, opts.maxWindows ?? 12);
  if (!elements) return null;

  const windowTraces: WindowTrace[] = [];
  const resolvedSoFar: string[] = [];
  const winners = new Map<number, string[]>();
  let usage: WindowAskResult["usage"];
  let wi = 0;

  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (e.kind === "anchor") {
      resolvedSoFar.push(...e.lines);
      continue;
    }
    const synthHunk: ConflictHunk = {
      startLine: hunk.startLine,
      endLine: hunk.endLine,
      oursLabel: hunk.oursLabel,
      theirsLabel: hunk.theirsLabel,
      ours: e.ours,
      theirs: e.theirs,
      base: e.base,
    };
    const candidates = enumerateCandidates(synthHunk);
    const { contextBefore, contextAfter } = windowContext(
      parsed,
      hunk,
      elements,
      i,
      resolvedSoFar,
    );
    const request = buildHunkRequest(
      parsed,
      synthHunk,
      candidates,
      { ...opts, contextBefore, contextAfter, situationSuffix: SITUATION_SUFFIX },
      opts,
    );

    let result;
    try {
      result = await ask(request);
    } catch (err) {
      windowTraces.push({
        index: wi,
        oursLines: e.ours.length,
        theirsLines: e.theirs.length,
        action: "escalate",
        reason: "ask-failed",
      });
      return {
        decision: {
          action: "escalate",
          reason: "ask-failed",
          detail: {
            verify: {},
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            windows: windowTraces,
            wholeHunkReason,
          },
        },
        usage,
      };
    }
    usage = addUsage(usage, result.usage);
    let d = interpret(result, candidates, opts);
    // Second opinion at window granularity too: a consistent re-pick that
    // clears the gates rescues a borderline window escalation.
    if (
      d.action === "escalate" &&
      d.reason !== "ask-failed" &&
      opts.secondOpinion !== false
    ) {
      const r2 = await ask(request);
      usage = addUsage(usage, r2.usage);
      const d2 = interpret(r2, candidates, opts);
      if (d2.action === "apply" && d2.candidate?.kind === d.detail.picked) d = d2;
    }
    windowTraces.push({
      index: wi,
      oursLines: e.ours.length,
      theirsLines: e.theirs.length,
      picked: d.detail.picked,
      confidence: d.detail.confidence,
      coverage: d.detail.coverage,
      action: d.action,
      reason: d.action === "escalate" ? d.reason : undefined,
    });
    if (d.action === "escalate") {
      return {
        decision: {
          action: "escalate",
          reason: d.reason,
          detail: { ...d.detail, windows: windowTraces, wholeHunkReason },
        },
        usage,
      };
    }
    winners.set(wi, d.candidate!.lines);
    resolvedSoFar.push(...d.candidate!.lines);
    wi++;
  }

  // Splice anchors + winners into the full replacement text.
  const lines: string[] = [];
  wi = 0;
  for (const e of elements) {
    if (e.kind === "anchor") lines.push(...e.lines);
    else lines.push(...(winners.get(wi++) ?? []));
  }

  // Verify the composition as a whole — window-level verifies judge parts;
  // a splice can be locally consistent and globally wrong.
  let spliceScore: number | undefined;
  if (!opts.noVerify) {
    const vr = await ask(buildSpliceVerifyRequest(parsed, hunk, lines, opts, opts));
    usage = addUsage(usage, vr.usage);
    const a = vr.answers[VERIFY_SPLICED];
    spliceScore =
      a?.type === "noul" ? (a as { noul: number }).noul : undefined;
    if (spliceScore !== undefined && spliceScore < 0.3) {
      return {
        decision: {
          action: "escalate",
          reason: "verification-failed",
          detail: {
            verify: { spliced: spliceScore },
            windows: windowTraces,
            wholeHunkReason,
          },
        },
        usage,
      };
    }
  }

  return {
    decision: {
      action: "apply",
      candidate: {
        kind: "spliced",
        description:
          "Line-level merge: the conflict was split into sub-regions and each resolved separately.",
        lines,
      },
      detail: {
        verify: spliceScore !== undefined ? { spliced: spliceScore } : {},
        windows: windowTraces,
        wholeHunkReason,
      },
    },
    usage,
  };
}

/**
 * Resolve every conflict hunk in `text`: enumerate candidates, ask Jev once
 * per hunk (fanned-out questions), apply winners, leave markers on
 * escalations so a human/LLM still sees them. Escalated hunks retry as
 * decomposed sub-conflicts unless `opts.decompose === false`.
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
      let decision = interpret(result, candidates, opts);
      let usage: HunkOutcome["usage"] = result.usage;

      // Second opinion: re-sample an escalated hunk once before decomposing.
      // Apply only if the resample picks the SAME candidate and now clears the
      // gates — pick-agreement across samples is real consistency, not noise.
      if (
        decision.action === "escalate" &&
        decision.reason !== "ask-failed" &&
        opts.secondOpinion !== false
      ) {
        const r2 = await ask(request);
        usage = addUsage(usage, r2.usage);
        const d2 = interpret(r2, candidates, opts);
        if (
          d2.action === "apply" &&
          d2.candidate?.kind === decision.detail.picked
        ) {
          d2.detail.secondOpinion = true;
          decision = d2;
        }
      }

      const wholeHunkProbs = decision.detail.probabilities;
      const wholeHunkPicked = decision.detail.picked;

      if (opts.decompose !== false) {
        const covFail =
          decision.action === "apply" &&
          decision.detail.coverage !== undefined &&
          decision.detail.coverage < (opts.minCoverage ?? 0.5);
        // Escalations retry per-window; applies with hedged coverage get
        // refined per-window too — a spliced verdict is strictly better
        // information than a single-side pick the model doubts covers it.
        if (
          (decision.action === "escalate" && decision.reason !== "ask-failed") ||
          covFail
        ) {
          const retry = await resolveHunkDecomposed(
            parsed,
            hunk,
            ask,
            opts,
            decision.action === "escalate" ? decision.reason : "not-in-candidates",
          );
          if (retry) {
            decision = retry.decision;
            usage = addUsage(usage, retry.usage);
          }
        }
      }

      // Head-to-head: a binary pick between the top-2 whole-hunk candidates
      // is a different elicitation than the N-way pick — sharper on
      // borderline hunks that survived every other retry.
      if (
        decision.action === "escalate" &&
        decision.reason !== "ask-failed" &&
        opts.headToHead !== false &&
        wholeHunkProbs
      ) {
        const top2 = Object.entries(wholeHunkProbs)
          .filter(([k]) => k !== NOVEL)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([k]) => candidates.find((c) => c.kind === k))
          .filter((c): c is Candidate => !!c);
        if (top2.length === 2) {
          const r3 = await ask(buildHunkRequest(parsed, hunk, top2, opts, opts));
          usage = addUsage(usage, r3.usage);
          const d3 = interpret(r3, top2, opts);
          // Apply only on confirmation: the binary pick must re-select the
          // original top candidate — a flip to the runner-up is exactly the
          // instability the gates were sensing.
          if (
            d3.action === "apply" &&
            d3.candidate?.kind === wholeHunkPicked
          ) {
            d3.detail.headToHead = true;
            decision = d3;
          }
        }
      }

      outcomes.push({ hunkIndex: i, hunk, decision, usage });
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
