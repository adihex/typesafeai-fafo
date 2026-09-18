#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { cmdDig } from "./cmd-dig.ts";
import { cmdEval } from "./cmd-eval.ts";
import { cmdResolve } from "./cmd-resolve.ts";

const USAGE = `fafo-resolve — merge conflicts adjudicated by TypeSafe Jev

usage:
  fafo-resolve resolve [files...]   resolve conflicted files (default: git's unmerged list)
  fafo-resolve dig <repo>           harvest conflict corpus from a repo's merge history
  fafo-resolve eval <corpus.jsonl>  score the resolver against dug ground truth

resolve options:
  --check             report decisions, write nothing
  --json            machine-readable report on stdout
  --verbose         show window traces and raw gate scores per hunk
  --show            print the resolved lines under each applied hunk
  --quiet           only the final summary
  --ours-intent T   what our change was trying to do (commit msg, free text)
  --theirs-intent T same for theirs
  --context N       context lines around each hunk (default 15)
  --min-confidence F  escalate below this choice confidence (default 0.5)
  --min-coverage F    escalate below this coverage noul (default 0.5)
  --min-verify F      reject winner below this verify noul (default 0.5)
  --no-verify       skip per-candidate verification nouls
  --no-decompose    skip per-window retry on escalated hunks
  --no-second-opinion  skip re-ask on escalation
  --no-head-to-head    skip top-2 binary re-pick
  --max-windows N   max sub-regions per hunk when decomposing (default 12)
  --model M         model override (default jev-latest)

dig options:
  --out FILE        append JSONL corpus to file (default: stdout)
  --limit N         max merge commits to scan (default 50)

eval options: same threshold flags plus
  --concurrency N   parallel entries (default 8)
  --json            machine-readable rows on stdout

exit codes: resolve/eval → 0 clean, 1 hunks escalated, 2 usage/error.
colors: on TTY only; NO_COLOR disables.

env: TYPESAFE_API_KEY must be set.
`;

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      check: { type: "boolean" },
      json: { type: "boolean" },
      "ours-intent": { type: "string" },
      "theirs-intent": { type: "string" },
      context: { type: "string" },
      "min-confidence": { type: "string" },
      "min-coverage": { type: "string" },
      "min-verify": { type: "string" },
      "no-verify": { type: "boolean" },
      "no-decompose": { type: "boolean" },
      "no-second-opinion": { type: "boolean" },
      "no-head-to-head": { type: "boolean" },
      "max-windows": { type: "string" },
      model: { type: "string" },
      out: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      verbose: { type: "boolean", short: "v" },
      quiet: { type: "boolean", short: "q" },
      show: { type: "boolean", short: "s" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || !cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return values.help || cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 2;
  }

  const shared = {
    oursIntent: values["ours-intent"],
    theirsIntent: values["theirs-intent"],
    contextLines: num(values.context, 15),
    minConfidence: num(values["min-confidence"], 0.5),
    minCoverage: num(values["min-coverage"], 0.5),
    minVerify: num(values["min-verify"], 0.5),
    noVerify: values["no-verify"] ?? false,
    decompose: values["no-decompose"] ? false : undefined,
    secondOpinion: values["no-second-opinion"] ? false : undefined,
    headToHead: values["no-head-to-head"] ? false : undefined,
    maxWindows: num(values["max-windows"], 12),
    model: values.model,
    json: values.json ?? false,
  };

  switch (cmd) {
    case "resolve":
      return cmdResolve({
        ...shared,
        files: positionals,
        check: values.check ?? false,
        verbose: values.verbose ?? false,
        quiet: values.quiet ?? false,
        show: values.show ?? false,
        cwd: process.cwd(),
      });
    case "dig": {
      const repo = positionals[0];
      if (!repo) throw new Error("dig needs a repo path");
      return cmdDig({ repo, out: values.out, limit: num(values.limit, 50) });
    }
    case "eval": {
      const corpus = positionals[0];
      if (!corpus) throw new Error("eval needs a corpus.jsonl path");
      return cmdEval({
        ...shared,
        corpus,
        cwd: process.cwd(),
        quiet: values.quiet ?? false,
        concurrency: num(values.concurrency, 8),
      });
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(USAGE);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
