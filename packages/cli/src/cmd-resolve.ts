import { readFileSync, writeFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  hasConflictMarkers,
  resolveText,
  type Asker,
  type ResolveOptions,
} from "@fafo/core";
import { conflictedPaths } from "./git.ts";

export interface ResolveCliOpts extends ResolveOptions {
  files: string[];
  check?: boolean;
  json?: boolean;
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
  let anyEscalated = 0;
  let touched = 0;

  for (const file of files) {
    const path = `${o.cwd}/${file}`;
    const text = readFileSync(path, "utf8");
    if (!hasConflictMarkers(text)) {
      console.error(`${file}: no conflict markers, skipping`);
      continue;
    }
    const res = await resolveText(text, ask, { ...o, filePath: file });
    touched += res.outcomes.length;
    anyEscalated += res.escalated;

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
    } else {
      for (const x of res.outcomes) {
        const d = x.decision;
        if (d.action === "apply") {
          console.error(
            `${file} hunk${x.hunkIndex}: apply ${d.candidate!.kind} (conf ${d.detail.confidence?.toFixed(2)}, cov ${d.detail.coverage?.toFixed(2)})`,
          );
        } else {
          console.error(`${file} hunk${x.hunkIndex}: ESCALATE ${d.reason}`);
        }
      }
    }
    if (!o.check && res.applied > 0) writeFileSync(path, res.text);
  }

  if (o.json) console.log(JSON.stringify(report, null, 2));
  if (!touched) return 0;
  console.error(
    `\n${touched} hunk(s): ${touched - anyEscalated} applied, ${anyEscalated} escalated` +
      (o.check ? " (check mode, nothing written)" : ""),
  );
  return anyEscalated ? 1 : 0;
}
