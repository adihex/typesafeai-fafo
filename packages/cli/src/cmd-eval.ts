import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { resolveText, type Asker, type ResolveOptions } from "@fafo/core";
import type { DigEntry } from "./cmd-dig.ts";

interface IntentInfo {
  msg: string;
  ours: string;
  theirs: string;
}

/** Optional sidecar: merge SHA → commit subjects for intent-aware state. */
function loadIntents(corpusPath: string): Record<string, IntentInfo> {
  const p = join(dirname(corpusPath), "intents.json");
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, IntentInfo>;
}

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
  const intents = loadIntents(o.corpus);
  const rows: unknown[] = [];
  let correct = 0;
  let resolvedByUs = 0;
  let escalated = 0;

  for (const e of entries) {
    const intent = intents[e.merge];
    const isPr = e.pr !== undefined;
    const res = await resolveText(e.conflicted, ask, {
      ...o,
      filePath: e.path,
      oursIntent: intent ? `${intent.msg} — ours-side tip: ${intent.ours}` : e.oursLabel,
      theirsIntent: intent
        ? `${intent.msg} — theirs-side tip: ${intent.theirs}`
        : isPr && e.title
          ? `PR #${e.pr} into ${e.base}: ${e.title}`
          : e.theirsLabel,
    });

    let verdict: string;
    if (isPr && e.resolved === null) {
      // Open PR: no recorded human resolution — verdict is apply vs escalate.
      verdict = res.escalated > 0 ? "escalated" : "applied";
      if (res.escalated > 0) escalated++;
      else resolvedByUs++;
    } else if (e.resolved === null) {
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
      merge: e.merge,
      ...(isPr ? { pr: e.pr, title: e.title, base: e.base } : {}),
      path: e.path,
      applied: res.applied,
      escalated: res.escalated,
      verdict,
      hunks: res.outcomes.map((x) => ({
        action: x.decision.action,
        candidate: x.decision.candidate?.kind,
        reason: x.decision.reason,
        wholeHunkReason: x.decision.detail.wholeHunkReason,
        windows: x.decision.detail.windows?.length,
        error: x.decision.detail.error,
        conf: x.decision.detail.confidence,
        cov: x.decision.detail.coverage,
      })),
    });
    if (!o.json) console.error(`${e.merge.slice(0, 16)} ${e.path}: ${verdict}`);
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
