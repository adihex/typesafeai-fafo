// fafo.ts — Hunk extension: resolve conflict markers in the reviewed tree
// via TypeSafe Jev. Select a conflicted file (or nothing = all files), press
// the key, Jev adjudicates each hunk; escalated hunks keep their markers.
//
// Install: copy to ~/.config/hunk/extensions/fafo.ts
// Requires: TYPESAFE_API_KEY in the environment hunk was launched from.
import type { HunkExtensionAPI } from "hunkdiff/extension";
import { spawn } from "node:child_process";

const CLI = [
  "tsx",
  "/Users/adityabalakrishnan/Projects/typesafeai-fafo/packages/cli/src/cli.ts",
];

interface FafoOutcome {
  hunk: number;
  action: string;
  candidate?: string;
  reason?: string;
}

interface FafoFileReport {
  file: string;
  applied: number;
  escalated: number;
  outcomes: FafoOutcome[];
}

function runFafo(cwd: string, file?: string): Promise<{ code: number; json: FafoFileReport[] }> {
  return new Promise((res) => {
    const p = spawn("npx", [...CLI, "resolve", "--json", ...(file ? [file] : [])], {
      cwd,
      env: process.env,
    });
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (code) => {
      try {
        res({ code: code ?? 2, json: JSON.parse(out) as FafoFileReport[] });
      } catch {
        res({ code: code ?? 2, json: [] });
      }
    });
    p.on("error", () => res({ code: 2, json: [] }));
  });
}

export default function (hunk: HunkExtensionAPI) {
  hunk.registerCommand(
    { id: "resolve", title: "FAFO: resolve conflicts with Jev", key: "ctrl+j" },
    async (ctx) => {
      const file = ctx.selection?.file?.path;
      ctx.notify(file ? `fafo: resolving ${file}…` : "fafo: resolving all conflicted files…");
      const { code, json } = await runFafo(ctx.cwd ?? process.cwd(), file);
      if (!json.length) {
        ctx.notify(code === 0 ? "fafo: no conflicted files" : "fafo: resolve failed", "warning");
        return;
      }
      for (const f of json) {
        const verdict =
          f.escalated === 0
            ? `${f.applied} hunk(s) applied`
            : `${f.applied} applied, ${f.escalated} escalated — markers kept`;
        ctx.notify(`${f.file}: ${verdict}`, f.escalated ? "warning" : "info");
      }
      await ctx.review?.requestReload?.();
    },
  );
}
