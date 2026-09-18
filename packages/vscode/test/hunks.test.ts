import { describe, expect, it } from "vitest";
import {
  parseConflicts,
  type ConflictHunk,
  type HunkOutcome,
} from "@fafo/core";
import {
  resolvedStartLines,
  singleHunkText,
  tryParseConflicts,
  verdictText,
} from "../src/hunks.ts";

const MULTI = `top
ctx-a
ctx-b
<<<<<<< HEAD
o1
=======
t1
>>>>>>> b
mid1
mid2
<<<<<<< HEAD
o2
=======
t2
>>>>>>> b
tail
`;

describe("tryParseConflicts", () => {
  it("returns null for clean text and malformed markers", () => {
    expect(tryParseConflicts("no conflict\n")).toBeNull();
    expect(tryParseConflicts("<<<<<<< a\nx\n")).toBeNull();
  });

  it("parses hunks", () => {
    expect(tryParseConflicts(MULTI)?.hunks).toHaveLength(2);
  });
});

describe("singleHunkText", () => {
  const parsed = parseConflicts(MULTI);

  it("yields a document with exactly one hunk", () => {
    for (const i of [0, 1]) {
      const sub = parseConflicts(singleHunkText(parsed, i, 20));
      expect(sub.hunks).toHaveLength(1);
      expect(sub.hunks[0].ours).toEqual([`o${i + 1}`]);
      expect(sub.hunks[0].theirs).toEqual([`t${i + 1}`]);
    }
  });

  it("includes real surrounding context but never a neighboring marker", () => {
    const sub = parseConflicts(singleHunkText(parsed, 1, 20));
    // all lines before the hunk are context (mid1, mid2, and earlier lines
    // up to the previous hunk's end marker are included)
    expect(sub.lines.slice(0, sub.hunks[0].startLine)).toContain("mid1");
    expect(sub.lines.slice(0, sub.hunks[0].startLine)).toContain("mid2");
    expect(sub.lines.slice(0, sub.hunks[0].startLine)).not.toContain("o1");
    expect(sub.lines.slice(0, sub.hunks[0].startLine)).not.toContain("t1");
    // and after
    expect(sub.lines.slice(sub.hunks[0].endLine)).toEqual(["tail", ""]);
  });

  it("clamps context at the neighbor hunk boundary", () => {
    // contextLines huge: context must still stop before hunk 0's end marker
    const sub = parseConflicts(singleHunkText(parsed, 1, 1000));
    const before = sub.lines.slice(0, sub.hunks[0].startLine);
    expect(before).toEqual(["mid1", "mid2"]);
  });
});

const hunk = (startLine: number, endLine: number): ConflictHunk => ({
  startLine,
  endLine,
  oursLabel: "HEAD",
  theirsLabel: "b",
  ours: ["o"],
  base: null,
  theirs: ["t"],
});

const outcome = (
  startLine: number,
  endLine: number,
  action: "apply" | "escalate",
  lines: string[] = [],
): HunkOutcome => ({
  hunkIndex: 0,
  hunk: hunk(startLine, endLine),
  decision:
    action === "apply"
      ? {
          action: "apply",
          candidate: { kind: "ours", description: "d", lines },
          detail: { verify: {}, confidence: 0.9 },
        }
      : { action: "escalate", reason: "low-confidence", detail: { verify: {} } },
});

describe("resolvedStartLines", () => {
  it("keeps positions when nothing is applied", () => {
    const outcomes = [outcome(3, 7, "escalate"), outcome(10, 14, "escalate")];
    expect(resolvedStartLines(outcomes)).toEqual([3, 10]);
  });

  it("shifts later hunks by the applied line delta", () => {
    // hunk 0 spans lines 3..7 (4 lines) → applied with 1 line: shift -3
    const outcomes = [
      outcome(3, 7, "apply", ["winner"]),
      outcome(10, 14, "escalate"),
    ];
    expect(resolvedStartLines(outcomes)).toEqual([3, 7]);
  });

  it("accumulates shifts across multiple applied hunks", () => {
    const outcomes = [
      outcome(3, 7, "apply", ["a", "b"]), // 4 lines → 2: shifts below by -2
      outcome(10, 14, "apply", []), // sits at 10-2=8; itself shrinks below by -4
    ];
    expect(resolvedStartLines(outcomes)).toEqual([3, 8]);
  });
});

describe("verdictText", () => {
  it("renders applied verdicts with kind and confidence", () => {
    const o = outcome(0, 4, "apply", ["x"]);
    o.decision.detail.coverage = 0.95;
    expect(verdictText(o)).toBe("jev → ours · conf 0.90 · cov 0.95");
  });

  it("renders escalations with the reason", () => {
    expect(verdictText(outcome(0, 4, "escalate"))).toBe(
      "escalated: low-confidence",
    );
  });

  it("includes the whole-hunk reason for spliced verdicts", () => {
    const o = outcome(0, 4, "escalate");
    o.decision.detail.wholeHunkReason = "not-in-candidates";
    o.decision.detail.windows = [
      { index: 0, oursLines: 1, theirsLines: 1, action: "apply", picked: "ours" },
      { index: 1, oursLines: 1, theirsLines: 1, action: "escalate", reason: "low-confidence" },
    ];
    expect(verdictText(o)).toBe(
      "escalated: low-confidence (whole-hunk: not-in-candidates)",
    );
  });
});
