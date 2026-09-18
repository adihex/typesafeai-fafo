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
  concurrency?: number;
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
  const rows: unknown[] = new Array(entries.length);
  let correct = 0;
  let resolvedByUs = 0;
  let escalated = 0;

  let idx = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(o.concurrency ?? 8, entries.length)) },
    async () => {
      while (idx < entries.length) {
        const i = idx++;
        const e = entries[i];
        const intent = intents[e.merge];
        let oursIntent: string | undefined = e.oursLabel;
        let theirsIntent: string | undefined = e.theirsLabel;
        if (intent) {
          // Decode merge direction: "Merge branch 'X' into Y" → ours=Y is the
          // destination branch, theirs=X is incoming. Explicit directives in
          // the message ("keep UAT values") get surfaced verbatim.
          const dir = intent.msg.match(/[Mm]erge\s+(?:branch\s+)?['"]?([\w./-]+)['"]?\s+into\s+['"]?([\w./-]+)['"]?/);
          const policy = intent.msg.match(/\(([^)]*keep[^)]*)\)/i)?.[1];
          const frame = [
            `Merge: ${intent.msg}`,
            dir ? `direction: '${dir[1]}' (theirs) → '${dir[2]}' (ours, destination branch)` : null,
            policy ? `resolution policy stated by merger: "${policy}"` : null,
          ].filter(Boolean).join("; ");
          oursIntent = `${frame}. ours-side (${dir?.[2] ?? "ours"}) change: ${intent.ours}`;
          theirsIntent = `${frame}. theirs-side (${dir?.[1] ?? "theirs"}) change: ${intent.theirs}`;
        }
        const res = await resolveText(e.conflicted, ask, {
          ...o,
          filePath: e.path,
          oursIntent,
          theirsIntent,
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

        rows[i] = {
          merge: e.merge.slice(0, 8),
          path: e.path,
          applied: res.applied,
          escalated: res.escalated,
          verdict,
          hunks: res.outcomes.map((x) => ({
            action: x.decision.action,
            candidate: x.decision.candidate?.kind,
            pick: x.decision.detail.picked,
            margin: x.decision.detail.pickMargin,
            verify: x.decision.detail.verify,
            discard: x.decision.detail.discard,
            reason: x.decision.reason,
            error: x.decision.detail.error,
            conf: x.decision.detail.confidence,
            cov: x.decision.detail.coverage,
            secondOpinion: x.decision.detail.secondOpinion,
            headToHead: x.decision.detail.headToHead,
            perLine: x.decision.detail.perLine,
            windows: x.decision.detail.windows?.map((w) => ({
              i: w.index,
              pick: w.picked,
              act: w.action,
              rsn: w.reason,
              pl: w.perLine,
            })),
          })),
        };
        if (!o.json) console.error(`${e.merge.slice(0, 8)} ${e.path}: ${verdict}`);
      }
    },
  );
  await Promise.all(workers);

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
