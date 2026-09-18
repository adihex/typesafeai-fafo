// fafo.ts — Hunk extension: resolve conflict markers in the reviewed tree
// via TypeSafe Jev, then annotate each adjudicated hunk with Jev's verdict
// (candidate, confidence, or escalation reason) as agent comments inside
// the diff.
//
// Install: copy to ~/.config/hunk/extensions/fafo.ts
// Requires: TYPESAFE_API_KEY in the environment hunk was launched from.
import type { HunkExtensionAPI } from "hunkdiff/extension";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI = [
  "tsx",
  "/Users/adityabalakrishnan/Projects/typesafeai-fafo/packages/cli/src/cli.ts",
];

interface FafoOutcome {
  hunk: number;
  action: string;
  candidate?: string;
  reason?: string;
  conf?: number;
  cov?: number;
}

interface FafoFileReport {
  file: string;
  applied: number;
  escalated: number;
  outcomes: FafoOutcome[];
}

function sh(
  cmd: string,
  args: string[],
  cwd: string,
  stdin?: string,
): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd, env: process.env });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", () => {}); // progress lines; JSON lives on stdout only
    if (stdin !== undefined) p.stdin.write(stdin);
    p.stdin.end();
    p.on("close", (code) => res({ code: code ?? 2, out }));
    p.on("error", () => res({ code: 2, out: "" }));
  });
}

/** Line numbers (1-based) of each <<<<<<< marker = per-conflict-hunk anchors. */
function markerLines(path: string): number[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .map((l, i) => (/^<{7}( |$)/.test(l) ? i + 1 : -1))
      .filter((i) => i > 0);
  } catch {
    return [];
  }
}

function conflictedFiles(cwd: string): Promise<string[]> {
  return sh("git", ["diff", "--name-only", "--diff-filter=U"], cwd).then(
    ({ out }) => out.split("\n").filter(Boolean),
  );
}

function outcomeSummary(o: FafoOutcome): string {
  if (o.action === "apply" && o.candidate) {
    const conf = o.conf !== undefined ? ` conf ${o.conf}` : "";
    const cov = o.cov !== undefined ? ` · cov ${o.cov}` : "";
    return `jev: ${o.candidate}${conf}${cov}`;
  }
  return `jev: escalated${o.reason ? ` — ${o.reason}` : ""}`;
}

export default function (hunk: HunkExtensionAPI) {
  hunk.registerCommand(
    { id: "resolve", title: "FAFO: resolve conflicts with Jev", key: "ctrl+j" },
    async (ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const file = ctx.selection?.file?.path;
      ctx.notify(file ? `fafo: resolving ${file}…` : "fafo: resolving all conflicted files…");

      // Anchor every conflict hunk to its marker line BEFORE resolve rewrites
      // the file — annotations target that position in the resulting diff.
      const targets = file ? [file] : await conflictedFiles(cwd);
      const anchors = new Map<string, number[]>(
        targets.map((f) => [f, markerLines(join(cwd, f))]),
      );

      const { code, out } = await sh(
        "npx",
        [...CLI, "resolve", "--json", ...(file ? [file] : [])],
        cwd,
      );
      let reports: FafoFileReport[] = [];
      try {
        reports = JSON.parse(out);
      } catch {
        /* resolve wrote progress to stderr; JSON parse failure = no reports */
      }
      if (!reports.length) {
        ctx.notify(code === 0 ? "fafo: no conflicted files" : "fafo: resolve failed", "warning");
        return;
      }

      const comments: { filePath: string; newLine: number; summary: string }[] = [];
      for (const f of reports) {
        const verdict =
          f.escalated === 0
            ? `${f.applied} hunk(s) applied`
            : `${f.applied} applied, ${f.escalated} escalated — markers kept`;
        ctx.notify(`${f.file}: ${verdict}`, f.escalated ? "warning" : "info");
        const lines = anchors.get(f.file) ?? [];
        for (const o of f.outcomes) {
          const line = lines[o.hunk];
          if (line) comments.push({ filePath: f.file, newLine: line, summary: outcomeSummary(o) });
        }
      }

      // Jev's rationale, inline in the diff. Needs the live session — soft-fail.
      if (comments.length) {
        await sh(
          "hunk",
          ["session", "comment", "apply", "--repo", cwd, "--stdin"],
          cwd,
          JSON.stringify({ comments }),
        );
      }
      await ctx.review?.requestReload?.();
    },
  );
}
