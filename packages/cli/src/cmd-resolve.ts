import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  hasConflictMarkers,
  resolveText,
  type Asker,
  type EscalationReason,
  type ResolveOptions,
} from "@fafo/core";
import { conflictedPaths } from "./git.ts";
import {
  dim,
  fmtDuration,
  fmtOutcome,
  fmtOutcomeVerbose,
  green,
  progress,
  reasonBreakdown,
  sym,
  yellow,
} from "./ui.ts";

export interface ResolveCliOpts extends ResolveOptions {
  files: string[];
  check?: boolean;
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  /** Print the resolved lines under each applied hunk (review aid). */
  show?: boolean;
  cwd: string;
}

export async function cmdResolve(o: ResolveCliOpts): Promise<number> {
  const files = o.files.length ? o.files : conflictedPaths(o.cwd);
  if (!files.length) {
    console.error("no conflicted files");
    return 0;
  }

  const client = new TypeSafeClient();
  const ask: Asker = (req) => client.systemOne(req) as never;
  const report: unknown[] = [];
  const escalateReasons: EscalationReason[] = [];
  let anyEscalated = 0;
  let touched = 0;
  let filesWithMarkersLeft = 0;
  const startedAt = Date.now();

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const path = resolvePath(o.cwd, file);
    const text = readFileSync(path, "utf8");
    if (!hasConflictMarkers(text)) {
      if (!o.json) console.error(`${sym.file} ${file}: no conflict markers, skipping`);
      continue;
    }
    if (!o.json && !o.quiet) {
      console.error(`${sym.file} ${progress(fi + 1, files.length, startedAt)} ${file}`);
    }
    const res = await resolveText(text, ask, { ...o, filePath: file });
    touched += res.outcomes.length;
    anyEscalated += res.escalated;
    if (res.escalated > 0) filesWithMarkersLeft++;
    for (const x of res.outcomes) {
      if (x.decision.action === "escalate" && x.decision.reason) {
        escalateReasons.push(x.decision.reason);
      }
    }

    if (o.json) {
      report.push({
        file,
        applied: res.applied,
        escalated: res.escalated,
        outcomes: res.outcomes.map((x) => ({
          hunk: x.hunkIndex,
          action: x.decision.action,
          candidate: x.decision.candidate?.kind,
          reason: x.decision.reason,
          ...x.decision.detail,
        })),
      });
    } else if (!o.quiet) {
      for (const x of res.outcomes) {
        console.error(`  ${fmtOutcome(x.hunkIndex, x.decision)}`);
        if (o.verbose) for (const l of fmtOutcomeVerbose(x.decision)) console.error(l);
        if (o.show && x.decision.action === "apply") {
          const lines = x.decision.candidate!.lines;
          const MAX = 8;
          for (const l of lines.slice(0, MAX)) console.error(green(`    + ${l}`));
          if (lines.length > MAX) console.error(dim(`    + … ${lines.length - MAX} more`));
          if (!lines.length) console.error(dim("    + (region dropped)"));
        }
      }
      if (res.escalated > 0 && !o.check) {
        console.error(dim(`  ${res.escalated} hunk(s) keep markers — resolve by hand or rerun`));
      }
    }
    if (!o.check && res.applied > 0) writeFileSync(path, res.text);
  }

  if (o.json) console.log(JSON.stringify(report, null, 2));
  if (!touched) return 0;

  const applied = touched - anyEscalated;
  const breakdown = reasonBreakdown(escalateReasons);
  const line =
    `${touched} hunk(s): ${green(String(applied))} applied` +
    (anyEscalated ? `, ${yellow(String(anyEscalated))} escalated (${breakdown})` : "") +
    dim(` · ${fmtDuration(Date.now() - startedAt)}`) +
    (o.check ? dim(" — check mode, nothing written") : "") +
    (filesWithMarkersLeft && !o.check
      ? dim(` — conflict markers left in ${filesWithMarkersLeft} file(s)`)
      : "");
  console.error(`\n${anyEscalated ? yellow("◆") : green("◆")} ${line}`);
  return anyEscalated ? 1 : 0;
}
