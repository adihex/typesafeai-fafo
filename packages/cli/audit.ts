// Spot-check: re-resolve sampled newly-applied entries, dump per-hunk verdict
// + applied text for manual eyeballing. QC scaffold — not product code.
import { readFileSync } from "node:fs";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { parseConflicts, resolveText, type DigEntry } from "@fafo/core";

const [corpusPath = ".auto/corpus-prs.jsonl", evalPath = ".auto/eval-prs-v3.json", wantFile] = process.argv.slice(2);

const client = new TypeSafeClient();
const ask = (req: any) => client.systemOne(req) as never;

const corpus = new Map<string, DigEntry>();
for (const line of readFileSync(corpusPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as DigEntry;
  corpus.set(`${e.merge}|${e.path}`, e);
}
const evalRows = new Map<string, any>();
for (const r of (JSON.parse(readFileSync(evalPath, "utf8")) as any).rows) {
  evalRows.set(`${r.merge}|${r.path}`, r);
}
const keys = readFileSync(wantFile!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
const clip = (s: string, n = 30) => {
  const ls = s.split("\n");
  return ls.length > n ? [...ls.slice(0, n), `  …(${ls.length - n} more lines)`].join("\n") : s;
};

const recStamp = (h: any) =>
  `${h.action}/${h.candidate ?? h.reason}${h.secondOpinion ? " [2op]" : ""}${h.headToHead ? " [h2h]" : ""}${h.perLine ? " [perLine]" : ""}` +
  `${h.wholeHunkReason ? ` (whole:${h.wholeHunkReason})` : ""} conf=${h.conf ?? "?"} cov=${h.cov ?? "?"} m=${h.margin ?? "?"}`;
const frStamp = (d: any) =>
  `${d.action}/${d.candidate?.kind ?? d.reason}${d.detail.secondOpinion ? " [2op]" : ""}${d.detail.headToHead ? " [h2h]" : ""}${d.detail.perLine ? " [perLine]" : ""}` +
  `${d.detail.wholeHunkReason ? ` (whole:${d.detail.wholeHunkReason})` : ""} conf=${d.detail.confidence?.toFixed(2) ?? "?"} cov=${d.detail.coverage?.toFixed(2) ?? "?"} m=${d.detail.pickMargin?.toFixed(2) ?? "?"}`;

for (const key of keys) {
  const e = corpus.get(key);
  const row = evalRows.get(key);
  if (!e || !row) { console.log(`### MISSING ${key}`); continue; }
  console.log(`\n${"=".repeat(100)}\n### ${key}  — ${e.title}`);
  console.log(`recorded verdict: ${row.verdict} (${row.hunks.filter((h: any) => h.action === "apply").length}/${row.hunks.length} hunks applied)`);
  const res = await resolveText(e.conflicted!, ask, {
    filePath: e.path,
    theirsIntent: `${e.title} (from ${e.theirsLabel} into ${e.oursLabel})`,
  });
  const hunks = parseConflicts(e.conflicted!).hunks;
  for (let i = 0; i < row.hunks.length; i++) {
    const rec = row.hunks[i];
    const out = res.outcomes.find((o) => o.hunkIndex === i);
    const d = out?.decision;
    const differs = d && (d.action !== rec.action || (d.candidate?.kind ?? null) !== (rec.candidate ?? null));
    console.log(`\n--- hunk ${i}: recorded ${recStamp(rec)} | fresh ${d ? frStamp(d) : "NO-OUTCOME"}${differs ? "  <<< FRESH-RUN DIFFERS" : ""}`);
    const hk = hunks[i];
    if (!hk) continue;
    console.log(`[OURS ${hk.ours.length}L]\n${clip(hk.ours.join("\n"))}\n[THEIRS ${hk.theirs.length}L]\n${clip(hk.theirs.join("\n"))}`);
    if (hk.base?.length && hk.base.length !== hk.ours.length && hk.base.length !== hk.theirs.length)
      console.log(`[BASE ${hk.base.length}L]\n${clip(hk.base.join("\n"), 14)}`);
    if (d?.action === "apply" && d.candidate)
      console.log(`[APPLIED — ${d.candidate.kind}, ${d.candidate.lines.length}L]\n${clip(d.candidate.lines.join("\n"), 40)}`);
    else if (d?.action === "escalate")
      console.log(`[ESCALATED — ${d.reason}]`);
    for (const w of d?.detail.windows ?? [])
      console.log(`   win${w.index} (${w.oursLines}o/${w.theirsLines}t): ${w.action}${w.picked ? `/${w.picked}` : ""}${w.reason ? ` ${w.reason}` : ""} conf=${w.confidence?.toFixed(2) ?? "?"}`);
  }
}
