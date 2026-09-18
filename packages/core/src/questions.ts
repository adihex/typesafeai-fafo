import {
  choice,
  noul,
  type JsonValue,
  type Questions,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";
import type { Candidate, ConflictHunk, HunkContext, ParsedConflicts } from "./types.ts";

export const PICK = "pick";
export const COVERED = "covered";
export const NOVEL = "needs-novel-merge";
export const VERIFY_SPLICED = "verify_spliced";
export const verifyKey = (kind: string) => `verify_${kind}`;

const NOVEL_DESCRIPTION =
  "None of the candidates is correct — resolving this conflict requires new or reworked code not present in either version.";

function block(tag: string, lines: string[]): string {
  return `--- ${tag} ---\n${lines.join("\n")}\n--- end ${tag} ---`;
}

/** Head+tail with an elision marker so the shape survives when a side is huge. */
function truncateLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return [
    ...lines.slice(0, head),
    `… [${lines.length - max} lines elided] …`,
    ...lines.slice(lines.length - tail),
  ];
}

/**
 * State for one hunk: the three versions, surrounding context, and whatever
 * intent the caller knows (branch labels, commit messages).
 */
export function buildState(
  parsed: ParsedConflicts,
  hunk: ConflictHunk,
  ctx: HunkContext,
): { [key: string]: JsonValue } {
  const n = ctx.contextLines ?? 15;
  const before =
    ctx.contextBefore ??
    parsed.lines.slice(Math.max(0, hunk.startLine - n), hunk.startLine);
  const after =
    ctx.contextAfter ?? parsed.lines.slice(hunk.endLine, hunk.endLine + n);

  const state: { [key: string]: JsonValue } = {
    situation:
      "A git merge produced a conflict in this file. Decide how the conflicted region should be resolved." +
      (ctx.situationSuffix ?? ""),
    versions: {
      ours: block(`OURS (${hunk.oursLabel || "ours"})`, truncateLines(hunk.ours, 150)),
      theirs: block(`THEIRS (${hunk.theirsLabel || "theirs"})`, truncateLines(hunk.theirs, 150)),
    },
    context_before: before.join("\n"),
    context_after: after.join("\n"),
  };
  if (hunk.base !== null) {
    (state.versions as Record<string, string>).base = block(
      "BASE (common ancestor)",
      truncateLines(hunk.base, 150),
    );
  }
  if (ctx.filePath) state.file = ctx.filePath;
  if (ctx.oursIntent || ctx.theirsIntent) {
    state.intent = {
      ours: ctx.oursIntent ?? hunk.oursLabel,
      theirs: ctx.theirsIntent ?? hunk.theirsLabel,
    };
  }
  return state;
}

/**
 * The fanned-out question set for one hunk, in a single request:
 * one Choice over candidates + a coverage Noul + one verification Noul
 * per candidate. Independent questions, asked together.
 */
export function buildHunkRequest(
  parsed: ParsedConflicts,
  hunk: ConflictHunk,
  candidates: Candidate[],
  ctx: HunkContext,
  opts: { noVerify?: boolean; model?: string } = {},
): SystemOneRequest<Questions> {
  const criteria: Record<string, string> = {};
  for (const c of candidates) criteria[c.kind] = c.description;
  criteria[NOVEL] = NOVEL_DESCRIPTION;

  const questions: Questions = {
    [PICK]: choice(
      "Which candidate is the correct resolution for this conflict? Judge by what each side's change was for: the right answer may keep one side, keep both, or restore the base — and it does not keep work that is moot, duplicated, or already subsumed by the other side.",
      criteria,
    ),
    [COVERED]: noul(
      "Is the correct resolution of this conflict fully contained in one of the listed candidates — meaning no new code, edits, or synthesis beyond them is required?",
    ),
  };

  if (!opts.noVerify) {
    for (const c of candidates) {
      questions[verifyKey(c.kind)] = noul({
        instruction: `If candidate "${c.kind}" were applied — ${c.description} — would the result preserve the intent of BOTH the OURS and THEIRS changes (or correctly discard work that is genuinely moot)?`,
        candidate_result: block(`candidate ${c.kind}`, truncateLines(c.lines, 60)),
      });
    }
  }

  const request: SystemOneRequest<Questions> = {
    state: buildState(parsed, hunk, ctx),
    questions,
  };
  if (opts.model) request.model = opts.model;
  return request;
}

/**
 * Last-resort composition ask: one keep/drop noul per non-shared union
 * line. Shared (anchor) lines are not asked — they are in both versions.
 * Lets Jev compose subsets no enumerated candidate can express.
 */
export function buildPerLineRequest(
  parsed: ParsedConflicts,
  hunk: ConflictHunk,
  lines: Array<{ line: string; side: "ours" | "theirs" }>,
  ctx: HunkContext,
  opts: { model?: string } = {},
): SystemOneRequest<Questions> {
  const questions: Questions = {};
  lines.forEach((l, i) => {
    questions[`keep_${i}`] = noul({
      instruction: `Should this exact line from ${l.side.toUpperCase()} appear in the correct resolution of the conflict? Yes if the resolved file should contain it, no if the resolution drops it.`,
      line: l.line,
    });
  });
  const request: SystemOneRequest<Questions> = {
    state: buildState(parsed, hunk, ctx),
    questions,
  };
  if (opts.model) request.model = opts.model;
  return request;
}

/**
 * Verification ask for a stitched splice: one noul over the composed result
 * against the original whole hunk's context. Window-level verifies judge
 * parts; this judges the composition.
 */
export function buildSpliceVerifyRequest(
  parsed: ParsedConflicts,
  hunk: ConflictHunk,
  splicedLines: string[],
  ctx: HunkContext,
  opts: { model?: string } = {},
): SystemOneRequest<Questions> {
  const request: SystemOneRequest<Questions> = {
    state: buildState(parsed, hunk, ctx),
    questions: {
      [VERIFY_SPLICED]: noul({
        instruction:
          "If this merged result were applied, would it preserve the intent of BOTH the OURS and THEIRS changes (or correctly discard work that is genuinely moot)?",
        candidate_result: block("spliced resolution", truncateLines(splicedLines, 60)),
      }),
    },
  };
  if (opts.model) request.model = opts.model;
  return request;
}
