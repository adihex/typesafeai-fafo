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

  it("ignores marker-shaped content lines (setext underlines, long runs)", () => {
    const text = `<<<<<<< ours
Title
=====
theirs stuff
=======
Title2
=================================
more
>>>>>>> theirs
`;
    const { hunks } = parseConflicts(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].ours).toEqual(["Title", "=====", "theirs stuff"]);
    expect(hunks[0].theirs).toEqual(["Title2", "=================================", "more"]);
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

  it("repairs trailing commas in composed candidates for .json files", () => {
    const cs = enumerateCandidates(
      hunk({ ours: ['"a": 1,', "}"], theirs: ['"b": 2,', "}"] }),
      "f.json",
    );
    const union = cs.find((c) => c.kind === "union")!;
    expect(union.lines).toEqual(['"a": 1', "}", '"b": 2,']);
    const both = cs.find((c) => c.kind === "both-ours-theirs")!;
    expect(both.lines).toEqual(['"a": 1', "}", '"b": 2', "}"]);
  });

  it("leaves trailing commas verbatim for non-json files", () => {
    const cs = enumerateCandidates(
      hunk({ ours: ['"a": 1,', "}"], theirs: ['"b": 2,', "}"] }),
      "f.ts",
    );
    const union = cs.find((c) => c.kind === "union")!;
    expect(union.lines).toEqual(['"a": 1,', "}", '"b": 2,']);
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
        [PICK]: { type: "choice", choice: "ours", confidence: 0.2, probabilities: {} },
      }),
      candidates,
    );
    expect(d.reason).toBe("low-confidence");
  });

  it("applies when only one signal hedges (quorum)", () => {
    const d = interpret(
      result({ [COVERED]: { type: "noul", noul: 0.45 } }),
      candidates,
    );
    expect(d.action).toBe("apply");
  });

  it("escalates when two signals fail weakly (quorum)", () => {
    const d = interpret(
      result({
        [COVERED]: { type: "noul", noul: 0.45 },
        [PICK]: { type: "choice", choice: "ours", confidence: 0.4, probabilities: {} },
      }),
      candidates,
    );
    expect(d.action).toBe("escalate");
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

  it("repairs a boundary trailing comma instead of vetoing", async () => {
    const JSON_CONFLICT = `{
  "name": "x",
<<<<<<< HEAD
  "a": 1,
=======
  "b": 2
>>>>>>> b
}
`;
    // "ours" leaves a trailing comma before "}" — strict JSON can't contain
    // it, so file-level repair drops the comma and the apply stands.
    const res = await resolveText(JSON_CONFLICT, asker(result()), {
      filePath: "f.json",
    });
    expect(res.applied).toBe(1);
    expect(JSON.parse(res.text)).toEqual({ name: "x", a: 1 });
    expect(hasConflictMarkers(res.text)).toBe(false);
  });

  it("vetoes every apply when the composed .json file still doesn't parse", async () => {
    const JSON_CONFLICT = `{
  "name": "x",
<<<<<<< HEAD
  "a":
=======
  "b": 2
>>>>>>> b
}
`;
    // "ours" is truncated — no comma repair can save it, so every apply is
    // vetoed and the markers stay.
    const res = await resolveText(JSON_CONFLICT, asker(result()), {
      filePath: "f.json",
    });
    expect(res.applied).toBe(0);
    expect(res.outcomes[0].decision.reason).toBe("invalid-composition");
    expect(hasConflictMarkers(res.text)).toBe(true);
  });

  it("skips repair and veto when the .json file is actually JSONC", async () => {
    const JSON_CONFLICT = `{
  // trailing commas are fine here
<<<<<<< HEAD
  "a": 1,
=======
  "b": 2
>>>>>>> b
}
`;
    const res = await resolveText(JSON_CONFLICT, asker(result()), {
      filePath: "f.json",
    });
    expect(res.applied).toBe(1);
    expect(res.text).toContain('"a": 1,');
    expect(hasConflictMarkers(res.text)).toBe(false);
  });

  it("keeps applies when the composed .json file parses", async () => {
    const JSON_CONFLICT = `{
  "name": "x",
<<<<<<< HEAD
  "a": 1
=======
  "b": 2
>>>>>>> b
}
`;
    const res = await resolveText(JSON_CONFLICT, asker(result()), {
      filePath: "f.json",
    });
    expect(res.applied).toBe(1);
    expect(hasConflictMarkers(res.text)).toBe(false);
  });

  it("keeps applies when a duplicated block exists in both hunks' sources", async () => {
    // The block is verbatim in each hunk's ours side — the conflicted file
    // already carried it twice, so emitting it twice is carried-through,
    // not a synthesized contradiction.
    const block = [
      "alpha_field_one",
      "alpha_field_two",
      "alpha_field_three",
      "alpha_field_four",
      "alpha_field_five",
    ].join("\n");
    const DUP = `a
<<<<<<< HEAD
${block}
=======
t1
>>>>>>> b
mid
<<<<<<< HEAD
${block}
=======
t2
>>>>>>> b
z
`;
    const res = await resolveText(DUP, asker(result()));
    expect(res.applied).toBe(2);
    expect(hasConflictMarkers(res.text)).toBe(false);
  });

  it("vetoes a hunk that synthesizes a block another hunk emitted", async () => {
    // hunk0's union spans a side boundary, producing a 5-line window that
    // exists in NEITHER side's lines — a synthesized duplicate of the block
    // hunk1 carries verbatim from its source.
    const DUP = `a
<<<<<<< HEAD
aaa_1
bbb_2
=======
ccc_3
ddd_4
eee_5
>>>>>>> b
mid
<<<<<<< HEAD
aaa_1
bbb_2
ccc_3
ddd_4
eee_5
=======
t2
>>>>>>> b
z
`;
    let call = 0;
    const seq: Asker = async () => {
      call++;
      if (call === 1) {
        return result({
          [PICK]: {
            type: "choice",
            choice: "both-ours-theirs",
            confidence: 0.9,
            probabilities: {
              "both-ours-theirs": 0.9,
              ours: 0.05,
              theirs: 0.05,
            },
          },
          [verifyKey("both-ours-theirs")]: { type: "noul", noul: 0.9 },
        });
      }
      return result();
    };
    const res = await resolveText(DUP, seq);
    expect(res.applied).toBe(1);
    expect(res.outcomes[0].decision.reason).toBe("invalid-composition");
    expect(res.outcomes[1].decision.action).toBe("apply");
    expect(hasConflictMarkers(res.text)).toBe(true);
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
    const res = await resolveText(INTERLEAVED, ask, { perLine: false });
    expect(res.escalated).toBe(1);
    expect(res.outcomes[0].decision.detail.wholeHunkReason).toBe("not-in-candidates");
    expect(hasConflictMarkers(res.text)).toBe(true);
  });

  it("does not retry when decompose and secondOpinion are off", async () => {
    let calls = 0;
    const ask: Asker = async () => {
      calls++;
      return pickResult("ours", { [COVERED]: { type: "noul", noul: 0.1 } });
    };
    await resolveText(INTERLEAVED, ask, {
      decompose: false,
      secondOpinion: false,
      perLine: false,
    });
    expect(calls).toBe(1);
  });

  it("applies a consistent second opinion after a gated first pick", async () => {
    let calls = 0;
    const ask: Asker = async () => {
      calls++;
      // first sample: confidence fails gates; second: same pick, clean signals
      return calls === 1
        ? pickResult("ours", { [COVERED]: { type: "noul", noul: 0.1 } })
        : pickResult("ours", { [COVERED]: { type: "noul", noul: 0.95 } });
    };
    const res = await resolveText(INTERLEAVED, ask, { decompose: false });
    expect(calls).toBe(2);
    expect(res.applied).toBe(1);
    expect(res.outcomes[0].decision.detail.secondOpinion).toBe(true);
    expect(res.outcomes[0].decision.candidate?.kind).toBe("ours");
  });

  it("stays escalated when the second opinion picks differently", async () => {
    let calls = 0;
    const ask: Asker = async () => {
      calls++;
      return calls === 1
        ? pickResult("ours", { [COVERED]: { type: "noul", noul: 0.1 } })
        : pickResult("theirs", { [COVERED]: { type: "noul", noul: 0.95 } });
    };
    const res = await resolveText(INTERLEAVED, ask, {
      decompose: false,
      perLine: false,
    });
    expect(res.escalated).toBe(1);
  });

  it("falls back to a head-to-head between the top-2 candidates", async () => {
    let calls = 0;
    const ask: Asker = async () => {
      calls++;
      if (calls === 1) {
        return {
          model: "jev-test",
          answers: {
            [PICK]: {
              type: "choice",
              choice: "ours",
              confidence: 0.9,
              probabilities: { ours: 0.4, theirs: 0.35, base: 0.25 },
            },
            [COVERED]: { type: "noul", noul: 0.1 },
          } as never,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      return pickResult("ours");
    };
    const res = await resolveText(INTERLEAVED, ask, {
      decompose: false,
      secondOpinion: false,
    });
    expect(calls).toBe(2);
    expect(res.applied).toBe(1);
    expect(res.outcomes[0].decision.detail.headToHead).toBe(true);
    expect(res.outcomes[0].decision.candidate?.kind).toBe("ours");
  });

  it("composes a resolution by per-line keep/drop as a last resort", async () => {
    const ask: Asker = async (req) => {
      const q = req.questions as Record<string, unknown>;
      if (q["keep_0"]) {
        const answers: Record<string, unknown> = {};
        // keep_0: import{a} ours, keep_1: import{a,b} theirs,
        // keep_2: callOurs ours, keep_3: callTheirs theirs, keep_4: extra theirs
        for (const [i, n] of [0.9, 0.1, 0.8, 0.9, 0.1].entries()) {
          answers[`keep_${i}`] = { type: "noul", noul: n };
        }
        return { model: "jev-test", answers: answers as never, usage: { input_tokens: 1, output_tokens: 1 } };
      }
      if (q["verify_spliced"]) {
        return {
          model: "jev-test",
          answers: { verify_spliced: { type: "noul", noul: 0.8 } } as never,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      return pickResult("ours", { [COVERED]: { type: "noul", noul: 0.1 } });
    };
    const res = await resolveText(INTERLEAVED, ask, {
      decompose: false,
      secondOpinion: false,
    });
    expect(res.applied).toBe(1);
    expect(res.outcomes[0].decision.detail.perLine).toBe(true);
    expect(res.text).toContain('import { a } from "x";');
    expect(res.text).toContain("shared();");
    expect(res.text).toContain("callOurs();");
    expect(res.text).toContain("callTheirs();");
    expect(res.text).not.toContain("extra()");
    expect(hasConflictMarkers(res.text)).toBe(false);
  });

  it("weaves kept lines in base order for diff3 hunks", async () => {
    // theirs replaced base line 0, ours replaced base line 1 — a keep-all
    // composition must emit theirsEdit before oursEdit, which block order
    // (all ours then all theirs) could never express.
    const WEAVE = `head
<<<<<<< ours
b0
oursEdit
||||||| base
b0
b1
=======
theirsEdit
b1
>>>>>>> theirs
tail
`;
    const ask: Asker = async (req) => {
      const q = req.questions as Record<string, unknown>;
      if (q["keep_0"]) {
        const answers = Object.fromEntries(
          [0, 1, 2, 3].map((i) => [`keep_${i}`, { type: "noul", noul: 0.9 }]),
        );
        return {
          model: "jev-test",
          answers: answers as never,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      if (q["verify_spliced"]) {
        return {
          model: "jev-test",
          answers: { verify_spliced: { type: "noul", noul: 0.8 } } as never,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      return pickResult("ours", { [COVERED]: { type: "noul", noul: 0.1 } });
    };
    const res = await resolveText(WEAVE, ask, {
      decompose: false,
      secondOpinion: false,
    });
    expect(res.applied).toBe(1);
    expect(res.text).toBe("head\nb0\ntheirsEdit\noursEdit\nb1\ntail\n");
  });
});
