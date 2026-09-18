import {
  hasConflictMarkers,
  parseConflicts,
  type HunkOutcome,
  type ParsedConflicts,
} from "@fafo/core";

/** Parse a document's conflicts; null when there are none or markers are malformed. */
export function tryParseConflicts(text: string): ParsedConflicts | null {
  if (!hasConflictMarkers(text)) return null;
  try {
    return parseConflicts(text);
  } catch {
    return null;
  }
}

/**
 * Build a synthetic document containing exactly one hunk plus real file
 * context around it, clamped so neighboring conflict markers don't become
 * extra hunks for resolveText to spend asks on. Context outside markers can
 * never contain `<<<<<<<` (the parser guarantees it), so clamping to the
 * adjacent hunks' boundaries is enough.
 */
export function singleHunkText(
  parsed: ParsedConflicts,
  index: number,
  contextLines: number,
): string {
  const hunk = parsed.hunks[index];
  const prevEnd = index > 0 ? parsed.hunks[index - 1].endLine : 0;
  const nextStart =
    index + 1 < parsed.hunks.length
      ? parsed.hunks[index + 1].startLine
      : parsed.lines.length;
  const from = Math.max(prevEnd, hunk.startLine - contextLines);
  const to = Math.min(nextStart, hunk.endLine + contextLines);
  return parsed.lines.slice(from, to).join("\n");
}

/**
 * Line in the resolved document where each outcome's region begins. Applied
 * hunks shift everything below them (markers + both sides replaced by the
 * winner's line count); escalations keep markers and shift nothing.
 * Outcomes arrive in hunk order.
 */
export function resolvedStartLines(outcomes: HunkOutcome[]): number[] {
  let shift = 0;
  return outcomes.map((o) => {
    const line = o.hunk.startLine + shift;
    if (o.decision.action === "apply" && o.decision.candidate) {
      shift +=
        o.decision.candidate.lines.length - (o.hunk.endLine - o.hunk.startLine);
    }
    return line;
  });
}

/** One-line verdict for the CodeLens/audit view. */
export function verdictText(o: HunkOutcome): string {
  const d = o.decision;
  if (d.action === "apply") {
    const parts = [`jev → ${d.candidate?.kind ?? "?"}`];
    if (d.detail.confidence !== undefined) {
      parts.push(`conf ${d.detail.confidence.toFixed(2)}`);
    }
    if (d.detail.coverage !== undefined) {
      parts.push(`cov ${d.detail.coverage.toFixed(2)}`);
    }
    if (d.detail.windows?.length) {
      parts.push(`${d.detail.windows.length} windows`);
    }
    return parts.join(" · ");
  }
  const inner =
    d.detail.wholeHunkReason && d.detail.wholeHunkReason !== d.reason
      ? ` (whole-hunk: ${d.detail.wholeHunkReason})`
      : "";
  return `escalated: ${d.reason ?? "unknown"}${inner}`;
}
