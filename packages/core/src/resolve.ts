import {
  enumerateCandidates,
  repairTrailingCommas,
} from "./candidates.ts";
import { decomposeHunk, type Element } from "./decompose.ts";
import { interpret } from "./interpret.ts";
import { parseConflicts } from "./parse.ts";
import { buildDiscardCheckRequest, buildHunkRequest, buildPerLineRequest, buildSpliceVerifyRequest, DISCARD_CHECK, DISCARDING, NOVEL, VERIFY_SPLICED } from "./questions.ts";
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
    const candidates = enumerateCandidates(synthHunk, opts.filePath);
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
    // Per-line rescue at window granularity: the union is small, so
    // keep/drop per line is cheap — and a composed subset can be the right
    // window answer when no flat candidate is. A failed window kills the
    // whole splice; this is the last shot before it does.
    let windowPerLine = false;
    if (
      d.action === "escalate" &&
      d.reason !== "ask-failed" &&
      opts.perLine !== false
    ) {
      const seen = new Set(e.ours.map((l) => l.replace(/\s+$/, "")));
      const askLines = [
        ...e.ours.map((l) => ({ line: l, side: "ours" as const })),
        ...e.theirs
          .filter((l) => !seen.has(l.replace(/\s+$/, "")))
          .map((l) => ({ line: l, side: "theirs" as const })),
      ];
      if (askLines.length > 0) {
        const r3 = await ask(
          buildPerLineRequest(
            parsed,
            synthHunk,
            askLines,
            { ...opts, contextBefore, contextAfter, situationSuffix: SITUATION_SUFFIX },
            opts,
          ),
        );
        usage = addUsage(usage, r3.usage);
        const nouls = askLines.map((_, i) => {
          const a = r3.answers[`keep_${i}`];
          return a?.type === "noul" ? (a as { noul: number }).noul : undefined;
        });
        const kept = askLines
          .filter((_, i) => nouls[i] !== undefined && nouls[i]! >= 0.5)
          .map((x) => x.line);
        // A composition built of confident line decisions is a real answer;
        // one built of ~0.5 coin-flips is noise — gate on decisiveness.
        const margins = nouls
          .filter((n): n is number => n !== undefined)
          .map((n) => Math.abs(n - 0.5));
        const meanMargin = margins.length
          ? margins.reduce((s, x) => s + x, 0) / margins.length
          : 0;
        // Only a genuine subset earns the apply — when keep/drop re-derives
        // an existing flat candidate it adds no information, and the flat
        // ask already declined to pick it.
        const isSubset =
          kept.length > 0 &&
          meanMargin >= 0.2 &&
          candidates.every(
            (c) => c.lines.join("\n") !== kept.join("\n"),
          );
        if (isSubset) {
          d = {
            action: "apply",
            candidate: {
              kind: "spliced",
              description:
                "Line-level merge: composed by per-line keep/drop over the window union.",
              lines: kept,
            },
            detail: { verify: {}, perLine: true },
          };
          windowPerLine = true;
        }
      }
    }
    windowTraces.push({
      index: wi,
      oursLines: e.ours.length,
      theirsLines: e.theirs.length,
      picked: d.detail.picked,
      perLine: windowPerLine || undefined,
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
    const candidates = enumerateCandidates(hunk, opts.filePath);
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

      // Discard audit: a borderline pick that drops the other side's work
      // must survive a focused check on the actual lines being lost.
      // Single-side picks that silently kill real work are the dominant
      // wrong-apply shape — asymmetric gates for the dangerous direction.
      if (
        decision.action === "apply" &&
        DISCARDING.has(decision.candidate!.kind) &&
        (decision.detail.confidence ?? 0) < 0.6 &&
        !opts.noVerify
      ) {
        const oursSet = new Set(hunk.ours.map((l) => l.replace(/\s+$/, "")));
        const theirsSet = new Set(hunk.theirs.map((l) => l.replace(/\s+$/, "")));
        const kind = decision.candidate!.kind;
        const dropped =
          kind === "ours"
            ? hunk.theirs.filter((l) => !oursSet.has(l.replace(/\s+$/, "")))
            : kind === "theirs"
              ? hunk.ours.filter((l) => !theirsSet.has(l.replace(/\s+$/, "")))
              : [
                  ...hunk.ours.filter((l) => !theirsSet.has(l.replace(/\s+$/, ""))),
                  ...hunk.theirs.filter((l) => !oursSet.has(l.replace(/\s+$/, ""))),
                ];
        if (dropped.length > 0) {
          const dr = await ask(
            buildDiscardCheckRequest(parsed, hunk, dropped, kind, opts, opts),
          );
          usage = addUsage(usage, dr.usage);
          const a = dr.answers[DISCARD_CHECK];
          const score = a?.type === "noul" ? (a as { noul: number }).noul : undefined;
          if (score !== undefined && score < 0.5) {
            decision = {
              action: "escalate",
              reason: "discards-work",
              detail: { ...decision.detail, discard: { check: score } },
            };
          }
        }
      }

      // Per-line composition: last resort when no enumerated candidate can
      // express the resolution. Keep/drop per non-shared union line
      // (anchors are kept — they are in both versions), then the composed
      // subset is verified like a splice.
      if (
        decision.action === "escalate" &&
        (decision.reason === "not-in-candidates" ||
          decision.reason === "novel-merge-needed") &&
        opts.perLine !== false
      ) {
        const { elements } = decomposeHunk(hunk, 1);
        const asked: Array<{ line: string; side: "ours" | "theirs" }> = [];
        const slots: Array<string[] | number[]> = [];
        for (const e of elements) {
          if (e.kind === "anchor") {
            slots.push(e.lines);
            continue;
          }
          const idxs: number[] = [];
          const seen = new Set(e.ours);
          for (const l of e.ours) {
            idxs.push(asked.length);
            asked.push({ line: l, side: "ours" });
          }
          for (const l of e.theirs) {
            if (seen.has(l)) continue;
            idxs.push(asked.length);
            asked.push({ line: l, side: "theirs" });
          }
          slots.push(idxs);
        }
        if (asked.length > 0 && asked.length <= 40) {
          const r4 = await ask(
            buildPerLineRequest(parsed, hunk, asked, opts, opts),
          );
          usage = addUsage(usage, r4.usage);
          const nouls = asked.map((_, i) => {
            const a = r4.answers[`keep_${i}`];
            return a?.type === "noul" ? (a as { noul: number }).noul : undefined;
          });
          const keep = nouls.map((n) => n !== undefined && n >= 0.5);
          const lines = slots.flatMap((s) =>
            typeof s[0] === "string"
              ? (s as string[])
              : (s as number[])
                  .filter((i) => keep[i])
                  .map((i) => asked[i].line),
          );
          // Decisiveness gate: a composition of confident line decisions is
          // a real answer; one of ~0.5 coin-flips is noise.
          const margins = nouls
            .filter((n): n is number => n !== undefined)
            .map((n) => Math.abs(n - 0.5));
          const meanMargin = margins.length
            ? margins.reduce((s, x) => s + x, 0) / margins.length
            : 0;
          // Only apply a composition that differs from every flat
          // candidate — re-deriving a pick the gates already rejected
          // (or the discard audit just vetoed) adds no information.
          const novel =
            lines.length > 0 &&
            meanMargin >= 0.2 &&
            candidates.every((c) => c.lines.join("\n") !== lines.join("\n"));
          if (novel) {
            let spliceScore: number | undefined;
            if (!opts.noVerify) {
              const vr = await ask(
                buildSpliceVerifyRequest(parsed, hunk, lines, opts, opts),
              );
              usage = addUsage(usage, vr.usage);
              const a = vr.answers[VERIFY_SPLICED];
              spliceScore =
                a?.type === "noul" ? (a as { noul: number }).noul : undefined;
            }
            // Same strong-fail gate as window splices — 0.5 was measured to
            // kill good compositions along with bad ones (it does not
            // discriminate for composed candidates).
            if (spliceScore === undefined || spliceScore >= 0.3) {
              decision = {
                action: "apply",
                candidate: {
                  kind: "spliced",
                  description:
                    "Line-level merge: composed by per-line keep/drop over the union.",
                  lines,
                },
                detail: {
                  verify:
                    spliceScore !== undefined ? { spliced: spliceScore } : {},
                  perLine: true,
                  wholeHunkReason: decision.reason,
                },
              };
            }
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
  const splice = () => {
    const out = [...parsed.lines];
    for (const o of [...outcomes].reverse()) {
      if (o.decision.action !== "apply") continue;
      out.splice(
        o.hunk.startLine,
        o.hunk.endLine - o.hunk.startLine,
        ...o.decision.candidate!.lines,
      );
    }
    return out;
  };
  let lines = splice();

  // Composed-file sanity: hunks decide independently, so the full file can
  // still be globally broken — unparseable JSON, or a block emitted twice by
  // different hunks. Veto the offending applies (all of them when the break
  // can't be attributed) so the markers stay for a human.
  const veto = new Set<number>();
  if (
    opts.filePath?.endsWith(".json") &&
    outcomes.length > 0 &&
    outcomes.every((o) => o.decision.action === "apply")
  ) {
    // Only meaningful for strict JSON — a file whose own context already has
    // // comments or comma-before-bracket is JSONC (tsconfig-style), where
    // neither repair nor a parse veto applies.
    const inHunk = new Set<number>();
    for (const h of parsed.hunks)
      for (let i = h.startLine; i < h.endLine; i++) inHunk.add(i);
    const ctx = parsed.lines.map((l, i) => (inHunk.has(i) ? "" : l));
    let jsoncish = false;
    for (let i = 0; i < ctx.length && !jsoncish; i++) {
      const t = ctx[i].trim();
      if (t.startsWith("//") || t.startsWith("/*")) {
        jsoncish = true;
        break;
      }
      if (!t.endsWith(",")) continue;
      for (let j = i + 1; j < ctx.length; j++) {
        const u = ctx[j].trim();
        if (u === "") {
          // A blanked hunk line means the comma's real successor is hunk
          // content — not a context pattern, so don't flag it.
          if (inHunk.has(j)) break;
          continue;
        }
        if (/^[}\])]/.test(u)) jsoncish = true;
        break;
      }
    }
    if (!jsoncish) {
      // Strict JSON can't contain `,\n}` anywhere, so repair can only move
      // the output toward a valid resolution — including commas at emitted
      // candidate/context boundaries that candidate-level repair can't see.
      lines = repairTrailingCommas(lines);
      try {
        JSON.parse(lines.join("\n"));
      } catch {
        outcomes.forEach((o, i) => {
          if (o.decision.action === "apply") veto.add(i);
        });
      }
    }
  }
  // Duplicated-block detection, keyed by what the hunk's own source already
  // contained: a >=5-line window emitted by two hunks (or twice within one
  // candidate) is only suspect when the emitting hunk's source lacked it —
  // that's the resolver synthesizing a duplicate, not carrying through a
  // block the file legitimately repeats (lockfiles, test boilerplate).
  const srcWindows = parsed.hunks.map((h) => {
    const s = new Set<string>();
    for (const side of [h.ours, h.theirs, h.base ?? []]) {
      const ls = side.map((l) => l.trim()).filter((l) => l !== "");
      for (let j = 0; j + 5 <= ls.length; j++) {
        const w = ls.slice(j, j + 5).join("\n");
        if (w.length >= 20) s.add(w);
      }
    }
    return s;
  });
  const windowOwners = new Map<string, Set<number>>();
  outcomes.forEach((o, i) => {
    if (o.decision.action !== "apply") return;
    const ls = o.decision.candidate!.lines
      .map((l) => l.trim())
      .filter((l) => l !== "");
    const seenLocal = new Set<string>();
    for (let j = 0; j + 5 <= ls.length; j++) {
      const w = ls.slice(j, j + 5).join("\n");
      if (w.length < 20) continue;
      if (seenLocal.has(w) && !srcWindows[o.hunkIndex].has(w)) veto.add(i);
      seenLocal.add(w);
      const s = windowOwners.get(w) ?? new Set<number>();
      s.add(i);
      windowOwners.set(w, s);
    }
  });
  for (const [w, owners] of windowOwners) {
    if (owners.size < 2) continue;
    for (const i of owners) {
      if (!srcWindows[outcomes[i].hunkIndex].has(w)) veto.add(i);
    }
  }
  if (veto.size > 0) {
    for (const i of veto) {
      outcomes[i].decision = {
        action: "escalate",
        reason: "invalid-composition",
        detail: outcomes[i].decision.detail,
      };
    }
    lines = splice();
  }

  return {
    text: lines.join("\n"),
    outcomes,
    applied: outcomes.filter((o) => o.decision.action === "apply").length,
    escalated: outcomes.filter((o) => o.decision.action === "escalate").length,
  };
}

export { escalateAll as _escalateAll };
