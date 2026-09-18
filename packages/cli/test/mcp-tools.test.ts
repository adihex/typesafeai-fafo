import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SystemOneResult, Questions } from "@typesafe-ai/sdk";
import { COVERED, PICK, verifyKey, type Asker } from "@fafo/core";
import { resolveFiles, scanConflicts } from "../src/mcp-tools.ts";

const TMP = mkdtempSync(join(tmpdir(), "fafo-mcp-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const CONFLICT = `import a from "a";

<<<<<<< HEAD
const timeout = 5000;
=======
const timeout = 10000;
>>>>>>> feature

console.log(timeout);
`;

function passingResult(): SystemOneResult<Questions> {
  return {
    model: "jev-test",
    answers: {
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
    } as SystemOneResult<Questions>["answers"],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

const stubAsk: Asker = async () => passingResult();

describe("scanConflicts", () => {
  it("reports files and hunk counts for an explicit list", () => {
    writeFileSync(join(TMP, "conflicted.ts"), CONFLICT);
    writeFileSync(join(TMP, "clean.ts"), "export const x = 1;\n");
    const res = scanConflicts(TMP, ["conflicted.ts", "clean.ts", "missing.ts"]);
    expect(res.files).toEqual([{ path: "conflicted.ts", hunks: 1 }]);
    expect(res.totalHunks).toBe(1);
  });
});

describe("resolveFiles", () => {
  it("applies and writes when the stubbed Jev passes gates", async () => {
    writeFileSync(join(TMP, "apply.ts"), CONFLICT);
    const res = await resolveFiles({ cwd: TMP, files: ["apply.ts"] }, stubAsk);
    expect(res.applied).toBe(1);
    expect(res.escalated).toBe(0);
    expect(res.written).toEqual(["apply.ts"]);
    expect(readFileSync(join(TMP, "apply.ts"), "utf8")).toContain(
      "const timeout = 5000;",
    );
  });

  it("check mode reports but writes nothing", async () => {
    writeFileSync(join(TMP, "dry.ts"), CONFLICT);
    const res = await resolveFiles(
      { cwd: TMP, files: ["dry.ts"], check: true },
      stubAsk,
    );
    expect(res.applied).toBe(1);
    expect(res.written).toEqual([]);
    expect(readFileSync(join(TMP, "dry.ts"), "utf8")).toContain("<<<<<<< HEAD");
  });

  it("keeps markers when Jev escalates", async () => {
    const lowCov: Asker = async () => ({
      ...passingResult(),
      answers: {
        ...passingResult().answers,
        [COVERED]: { type: "noul", noul: 0.1 },
      } as SystemOneResult<Questions>["answers"],
    });
    writeFileSync(join(TMP, "esc.ts"), CONFLICT);
    const res = await resolveFiles(
      { cwd: TMP, files: ["esc.ts"], decompose: false, secondOpinion: false, perLine: false },
      lowCov,
    );
    expect(res.escalated).toBe(1);
    expect(res.markersLeftIn).toEqual(["esc.ts"]);
    expect(readFileSync(join(TMP, "esc.ts"), "utf8")).toContain(">>>>>>> feature");
  });
});
