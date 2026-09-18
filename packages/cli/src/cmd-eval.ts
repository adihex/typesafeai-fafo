import { readFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { resolveText, type Asker, type ResolveOptions } from "@fafo/core";
import type { DigEntry } from "./cmd-dig.ts";

function normalize(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "")
    .join("\n");
}

/**
 * Run the resolver over a dig corpus and compare outcomes against the
 * human's recorded resolution. The whole point of the fafo: does Jev pick
 * correctly, and does confidence predict when it's wrong?
 */
export async function cmdEval(o: {
  corpus: string;
  cwd: string;
  json?: boolean;
} & ResolveOptions): Promise<number> {
  const entries = readFileSync(o.corpus, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as DigEntry);
  if (!entries.length) {
    console.error("empty corpus");
    return 2;
  }

  const client = new TypeSafeClient();
  const ask: Asker = (req) => client.systemOne(req) as never;
  const rows: unknown[] = [];
  let correct = 0;
  let resolvedByUs = 0;
  let escalated = 0;

  for (const e of entries) {
    const res = await resolveText(e.conflicted, ask, {
      ...o,
      filePath: e.path,
      oursIntent: e.oursLabel,
      theirsIntent: e.theirsLabel,
    });

    let verdict: string;
    if (e.resolved === null) {
      verdict = res.escalated > 0 ? "escalated (file deleted in truth)" : "applied (truth: deleted)";
      if (res.escalated > 0) escalated++;
    } else if (res.escalated > 0) {
      verdict = "escalated";
      escalated++;
    } else {
      resolvedByUs++;
      const match = normalize(res.text) === normalize(e.resolved);
      verdict = match ? "match" : "DIFFERS";
      if (match) correct++;
    }

    rows.push({
      merge: e.merge.slice(0, 8),
      path: e.path,
      applied: res.applied,
      escalated: res.escalated,
      verdict,
      hunks: res.outcomes.map((x) => ({
        action: x.decision.action,
        candidate: x.decision.candidate?.kind,
        reason: x.decision.reason,
        error: x.decision.detail.error,
        conf: x.decision.detail.confidence,
        cov: x.decision.detail.coverage,
      })),
    });
    if (!o.json) console.error(`${e.merge.slice(0, 8)} ${e.path}: ${verdict}`);
  }

  const summary = {
    entries: entries.length,
    escalated,
    resolvedByUs,
    matchedTruth: correct,
    matchRate: resolvedByUs ? correct / resolvedByUs : null,
    coverageNote:
      "matchRate is over hunks we applied; escalated entries are neither right nor wrong — they're the gate doing its job.",
  };
  if (o.json) console.log(JSON.stringify({ summary, rows }, null, 2));
  else console.error(`\nsummary: ${JSON.stringify(summary)}`);
  return 0;
}
