import { describe, expect, it } from "vitest";
import {
  enumerateCandidates,
  hasConflictMarkers,
  interpret,
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
    const res = await resolveText(CONFLICT_2WAY, asker(lowCov));
    expect(res.escalated).toBe(1);
    expect(hasConflictMarkers(res.text)).toBe(true);
  });

  it("resolves multiple hunks independently", async () => {
    const res = await resolveText(MULTI, asker(result()));
    expect(res.outcomes).toHaveLength(2);
    expect(res.text).toBe("a\no1\nmid\no2\nz\n");
  });
});
