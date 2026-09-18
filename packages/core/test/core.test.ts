import { describe, expect, it } from "vitest";
import {
  decomposeHunk,
  enumerateCandidates,
  hasConflictMarkers,
  interpret,
  lcsPairs,
  parseConflicts,
  ConflictParseError,
  resolveText,
  COVERED,
  NOVEL,
  PICK,
  verifyKey,
  type Asker,
  type Candidate,
  type ConflictHunk,
} from "../src/index.ts";
import type { SystemOneResult, Questions } from "@typesafe-ai/sdk";

const CONFLICT_2WAY = `import a from "a";

<<<<<<< HEAD
const timeout = 5000;
=======
const timeout = 10000;
>>>>>>> feature

console.log(timeout);
`;

const CONFLICT_DIFF3 = `x();
<<<<<<< HEAD
foo(1);
||||||| base
foo(0);
=======
foo(2);
>>>>>>> branch
y();
`;

const MULTI = `a
<<<<<<< HEAD
o1
=======
t1
>>>>>>> b
mid
<<<<<<< HEAD
o2
=======
t2
>>>>>>> b
z
`;

describe("parseConflicts", () => {
  it("parses two-way markers", () => {
    const { hunks } = parseConflicts(CONFLICT_2WAY);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].ours).toEqual(["const timeout = 5000;"]);
    expect(hunks[0].theirs).toEqual(["const timeout = 10000;"]);
    expect(hunks[0].base).toBeNull();
    expect(hunks[0].oursLabel).toBe("HEAD");
    expect(hunks[0].theirsLabel).toBe("feature");
  });

  it("parses diff3 markers with base", () => {
    const { hunks } = parseConflicts(CONFLICT_DIFF3);
    expect(hunks[0].base).toEqual(["foo(0);"]);
    expect(hunks[0].ours).toEqual(["foo(1);"]);
    expect(hunks[0].theirs).toEqual(["foo(2);"]);
  });

  it("parses multiple hunks", () => {
    const { hunks } = parseConflicts(MULTI);
    expect(hunks).toHaveLength(2);
    expect(hunks[1].startLine).toBeGreaterThan(hunks[0].endLine);
  });

  it("returns zero hunks for clean text", () => {
    expect(parseConflicts("no conflict\n").hunks).toHaveLength(0);
    expect(hasConflictMarkers("no conflict\n")).toBe(false);
  });

  it("throws on unterminated conflict", () => {
    expect(() => parseConflicts("<<<<<<< a\nx\n")).toThrow(ConflictParseError);
  });
});

const hunk = (o: Partial<ConflictHunk>): ConflictHunk => ({
  startLine: 0,
  endLine: 0,
  oursLabel: "HEAD",
  theirsLabel: "b",
  ours: ["a"],
  theirs: ["b"],
  base: null,
  ...o,
});

describe("enumerateCandidates", () => {
  it("enumerates the full set without base for two-way hunks", () => {
    // no shared lines: union === both-ours-theirs, so it dedupes away
    const kinds = enumerateCandidates(hunk({})).map((c) => c.kind);
    expect(kinds).toEqual([
      "ours",
      "theirs",
      "both-ours-theirs",
      "both-theirs-ours",
      "drop",
    ]);
  });

  it("keeps union distinct when the sides share lines", () => {
    const kinds = enumerateCandidates(
      hunk({ ours: ["shared", "a"], theirs: ["shared", "b"] }),
    ).map((c) => c.kind);
    expect(kinds).toContain("union");
  });

  it("includes base only when the hunk carries diff3 base", () => {
    const kinds = enumerateCandidates(hunk({ base: ["z"] })).map((c) => c.kind);
    expect(kinds).toContain("base");
  });

  it("dedupes candidates with identical output", () => {
    const cs = enumerateCandidates(hunk({ base: ["a"] }));
    const texts = cs.map((c) => c.lines.join("\n"));
    expect(new Set(texts).size).toBe(texts.length);
    // base ["a"] duplicates ours ["a"] — base should be gone
    expect(cs.map((c) => c.kind)).not.toContain("base");
  });
});

const candidates: Candidate[] = [
  { kind: "ours", description: "d", lines: ["a"] },
  { kind: "theirs", description: "d", lines: ["b"] },
  { kind: "drop", description: "d", lines: [] },
];

function result(over: Record<string, unknown> = {}): SystemOneResult<Questions> {
  const answers: Record<string, unknown> = {
    [PICK]: {
      type: "choice",
      choice: "ours",
      confidence: 0.9,
      probabilities: { ours: 0.9, theirs: 0.05, drop: 0.05 },
    },
    [COVERED]: { type: "noul", noul: 0.95 },
    [verifyKey("ours")]: { type: "noul", noul: 0.9 },
    [verifyKey("theirs")]: { type: "noul", noul: 0.1 },
    [verifyKey("drop")]: { type: "noul", noul: 0.05 },
    ...over,
  };
  return {
    model: "jev-test",
    answers: answers as SystemOneResult<Questions>["answers"],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe("interpret", () => {
  it("applies the winner when all gates pass", () => {
    const d = interpret(result(), candidates);
    expect(d.action).toBe("apply");
    expect(d.candidate?.kind).toBe("ours");
  });

  it("escalates when coverage says the answer isn't in the set", () => {
    const d = interpret(result({ [COVERED]: { type: "noul", noul: 0.2 } }), candidates);
    expect(d.action).toBe("escalate");
    expect(d.reason).toBe("not-in-candidates");
  });

  it("escalates when the model picks needs-novel-merge", () => {
    const d = interpret(
      result({ [PICK]: { type: "choice", choice: NOVEL, confidence: 0.8, probabilities: {} } }),
      candidates,
    );
    expect(d.reason).toBe("novel-merge-needed");
  });

  it("escalates when the winner fails verification", () => {
    const d = interpret(
      result({ [verifyKey("ours")]: { type: "noul", noul: 0.2 } }),
      candidates,
    );
    expect(d.reason).toBe("verification-failed");
  });

  it("escalates on low confidence", () => {
    const d = interpret(
      result({
        [PICK]: { type: "choice", choice: "ours", confidence: 0.3, probabilities: {} },
      }),
      candidates,
    );
    expect(d.reason).toBe("low-confidence");
  });
});

describe("resolveText", () => {
  const asker = (r: SystemOneResult<Questions>): Asker => async () => r;

  it("applies candidates and produces a clean file", async () => {
    const res = await resolveText(CONFLICT_2WAY, asker(result()));
    expect(res.applied).toBe(1);
    expect(res.text).toContain("const timeout = 5000;");
    expect(hasConflictMarkers(res.text)).toBe(false);
  });

  it("leaves markers on escalation", async () => {
    const lowCov = result({ [COVERED]: { type: "noul", noul: 0.1 } });
    const res = await resolveText(CONFLICT_2WAY, asker(lowCov), {
      decompose: false,
    });
    expect(res.escalated).toBe(1);
    expect(hasConflictMarkers(res.text)).toBe(true);
  });

  it("resolves multiple hunks independently", async () => {
    const res = await resolveText(MULTI, asker(result()));
    expect(res.outcomes).toHaveLength(2);
    expect(res.text).toBe("a\no1\nmid\no2\nz\n");
  });
});

describe("decomposeHunk", () => {
  it("splits a two-way hunk into anchors and windows", () => {
    const h = hunk({
      ours: ["same", "o1", "also"],
      theirs: ["same", "t1", "also"],
    });
    const { elements, windows } = decomposeHunk(h, 1);
    expect(windows).toBe(1);
    const kinds = elements.map((e) => e.kind);
    expect(kinds).toEqual(["anchor", "window", "anchor"]);
  });

  it("keeps multiple windows apart across anchors", () => {
    const h = hunk({
      ours: ["A", "o1", "B", "o2", "C"],
      theirs: ["A", "t1", "B", "t2", "C"],
    });
    const { windows } = decomposeHunk(h, 1);
    expect(windows).toBe(2);
  });

  it("merges windows across short anchors", () => {
    const h = hunk({
      ours: ["A", "o1", "B", "o2", "C"],
      theirs: ["A", "t1", "B", "t2", "C"],
    });
    // "B" is a 1-line anchor: minAnchor=2 merges the two windows into one
    const { windows } = decomposeHunk(h, 2);
    expect(windows).toBe(1);
  });

  it("recovers a window-level base span for diff3 hunks", () => {
    const h = hunk({
      base: ["keep", "old", "end"],
      ours: ["keep", "new-o", "end"],
      theirs: ["keep", "new-t", "end"],
    });
    const { elements } = decomposeHunk(h, 1);
    const w = elements.find((e) => e.kind === "window");
    expect(w && w.kind === "window" ? w.base : null).toEqual(["old"]);
  });

  it("finds LCS pairs", () => {
    expect(lcsPairs(["a", "b", "c"], ["x", "b", "c", "y"])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});

describe("resolveText with decomposition", () => {
  // An interleaved conflict: shared anchors with per-window choices.
  const INTERLEAVED = `head
<<<<<<< ours
import { a } from "x";
shared();
callOurs();
=======
import { a, b } from "x";
shared();
callTheirs();
extra();
>>>>>>> theirs
tail
`;

  function pickResult(
    choice: string,
    over: Record<string, unknown> = {},
  ): SystemOneResult<Questions> {
    const answers: Record<string, unknown> = {
      [PICK]: { type: "choice", choice, confidence: 0.9, probabilities: {} },
      [COVERED]: { type: "noul", noul: 0.95 },
      ...over,
    };
    return { model: "jev-test", answers: answers as never, usage: { input_tokens: 1, output_tokens: 1 } };
  }

  it("splices per-window winners when the whole hunk can't be covered", async () => {
    // Whole-hunk ask fails coverage; window asks pick by content.
    const ask: Asker = async (req) => {
      const state = req.state as { situation: string; versions: { ours: string; theirs: string } };
      if (!state.situation.includes("one window of a larger conflict")) {
        return pickResult("ours", { [COVERED]: { type: "noul", noul: 0.1 } });
      }
      const pick =
        state.versions.ours.includes("callOurs") ? "ours" : "theirs";
      return pickResult(pick);
    };
    const res = await resolveText(INTERLEAVED, ask);
    expect(res.applied).toBe(1);
    expect(res.outcomes[0].decision.candidate?.kind).toBe("spliced");
    expect(res.text).toContain("callOurs();");
    expect(res.text).toContain('import { a, b } from "x";');
    expect(hasConflictMarkers(res.text)).toBe(false);
  });

  it("escalates when a window verdict escalates", async () => {
    const ask: Asker = async (req) => {
      const state = req.state as { situation: string };
      if (!state.situation.includes("one window of a larger conflict")) {
        return pickResult("ours", { [COVERED]: { type: "noul", noul: 0.1 } });
      }
      return pickResult("ours", { [COVERED]: { type: "noul", noul: 0.1 } });
    };
    const res = await resolveText(INTERLEAVED, ask);
    expect(res.escalated).toBe(1);
    expect(res.outcomes[0].decision.detail.wholeHunkReason).toBe("not-in-candidates");
    expect(hasConflictMarkers(res.text)).toBe(true);
  });

  it("does not retry when decompose is off", async () => {
    let calls = 0;
    const ask: Asker = async () => {
      calls++;
      return pickResult("ours", { [COVERED]: { type: "noul", noul: 0.1 } });
    };
    await resolveText(INTERLEAVED, ask, { decompose: false });
    expect(calls).toBe(1);
  });
});
