import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { cmdInstallMergetool } from "../src/cmd-install-mergetool.ts";
import { renderEvalReport } from "../src/report.ts";

const TMP = mkdtempSync(join(tmpdir(), "fafo-cli-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function repo(name: string): string {
  const dir = join(TMP, name);
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}
const configGet = (cwd: string, key: string) =>
  execFileSync("git", ["config", "--local", "--get", key], { cwd, encoding: "utf8" }).trim();

describe("cmdInstallMergetool", () => {
  it("writes the mergetool contract into local git config", async () => {
    const dir = repo("local");
    const code = await cmdInstallMergetool({ local: true, cwd: dir });
    expect(code).toBe(0);
    expect(configGet(dir, "merge.tool")).toBe("fafo");
    expect(configGet(dir, "mergetool.fafo.cmd")).toContain('resolve "$MERGED"');
    expect(configGet(dir, "mergetool.fafo.trustExitCode")).toBe("true");
  });

  it("honors --cmd and --diff3", async () => {
    const dir = repo("custom");
    await cmdInstallMergetool({
      local: true,
      diff3: true,
      cmd: 'my-fafo run resolve "$MERGED"',
      cwd: dir,
    });
    expect(configGet(dir, "mergetool.fafo.cmd")).toBe('my-fafo run resolve "$MERGED"');
    expect(configGet(dir, "merge.conflictStyle")).toBe("diff3");
  });

  it("refuses --local outside a work tree", async () => {
    const dir = mkdtempSync(join(TMP, "not-a-repo-"));
    const code = await cmdInstallMergetool({ local: true, cwd: dir });
    expect(code).toBe(2);
  });
});

describe("renderEvalReport", () => {
  const data = {
    summary: { entries: 2, escalated: 1, resolvedByUs: 1, matchedTruth: 1, matchRate: 1 },
    rows: [
      {
        merge: "a1b2c3d4",
        path: "src/x.ts",
        applied: 1,
        escalated: 0,
        verdict: "match",
        resolvedTruth: "ok\n",
        resolvedOurs: "ok\n",
        hunks: [
          {
            action: "apply",
            candidate: "ours",
            conf: 0.9,
            cov: 0.95,
            ours: ["const a = 1;"],
            theirs: ["const a = 2;"],
            base: null,
            resolution: ["const a = 1;"],
          },
        ],
      },
      {
        merge: "e5f6a7b8",
        path: "src/y.ts",
        applied: 0,
        escalated: 1,
        verdict: "escalated",
        hunks: [
          {
            action: "escalate",
            reason: "novel-merge-needed",
            ours: ["<script>alert(1)</script>"],
            theirs: ["t"],
            resolution: null,
            windows: [{ index: 0, picked: "theirs", conf: 0.4, action: "escalate", reason: "low-confidence" }],
            wholeHunkReason: "novel-merge-needed",
          },
        ],
      },
    ],
  };

  it("renders summary stats and per-row verdicts", () => {
    const html = renderEvalReport(data);
    expect(html).toContain("fafo-resolve eval report");
    expect(html).toContain("<b>2</b><span>files</span>");
    expect(html).toContain("src/x.ts");
    expect(html).toContain("src/y.ts");
    expect(html).toContain("badge ok");
    expect(html).toContain("badge warn");
  });

  it("renders side-by-side ours/theirs/resolution and window traces", () => {
    const html = renderEvalReport(data);
    expect(html).toContain("apply ours");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("const a = 2;");
    expect(html).toContain("per-window trace");
    expect(html).toContain("whole-hunk: novel-merge-needed");
  });

  it("escapes HTML inside snippets", () => {
    const html = renderEvalReport(data);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("tolerates a bare rows array and missing fields", () => {
    const html = renderEvalReport([{ path: "only.ts" }]);
    expect(html).toContain("only.ts");
    expect(html).toContain("<b>1</b><span>files</span>");
  });
});
