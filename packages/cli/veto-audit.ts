// False-veto audit: for each invalid-composition hunk, reconstruct the
// vetoed candidate and classify the triggering ≥5L dup window as
// "inherited" (a source side already contained that repeat → false veto)
// or "created" by composition (→ real defect caught).
import { readFileSync } from "node:fs";
import {
  decomposeHunk,
  enumerateCandidates,
  parseConflicts,
  type CandidateKind,
  type ConflictHunk,
  type DigEntry,
} from "@fafo/core";

const [corpusPath = ".auto/corpus-prs.jsonl", evalPath = ".auto/eval-prs-v4.json"] = process.argv.slice(2);

const corpus = new Map<string, DigEntry>();
for (const line of readFileSync(corpusPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as DigEntry;
  corpus.set(`${e.merge}|${e.path}`, e);
}
const rows = (JSON.parse(readFileSync(evalPath, "utf8")) as any).rows as any[];

const WIN = 5;
const dupWindows = (ls: string[]) => {
  const seen = new Set<string>(); const dup = new Set<string>();
  for (let j = 0; j + WIN <= ls.length; j++) {
    const w = ls.slice(j, j + WIN).map((x) => x.trim()).join("\n");
    if (w.length < 20) continue;
    if (seen.has(w)) dup.add(w);
    seen.add(w);
  }
  return dup;
};
const sharedWindows = (a: string[], b: string[]) => {
  const sa = new Set<string>(), out = new Set<string>();
  for (let j = 0; j + WIN <= a.length; j++) { const w = a.slice(j, j + WIN).map((x) => x.trim()).join("\n"); if (w.length >= 20) sa.add(w); }
  for (let j = 0; j + WIN <= b.length; j++) { const w = b.slice(j, j + WIN).map((x) => x.trim()).join("\n"); if (sa.has(w)) out.add(w); }
  return out;
};
const countWindows = (ls: string[], w: string) => {
  let n = 0;
  for (let j = 0; j + WIN <= ls.length; j++) if (ls.slice(j, j + WIN).map((x) => x.trim()).join("\n") === w) n++;
  return n;
};

const candidateLines = (hunk: ConflictHunk, kind: CandidateKind) =>
  enumerateCandidates(hunk).find((c) => c.kind === kind)?.lines ?? null;
const splicedLines = (hunk: ConflictHunk, winRows: { pick: string }[]) => {
  for (const minAnchor of [1, 3, 8]) {
    const { elements } = decomposeHunk(hunk, minAnchor);
    const wins = elements.filter((e) => e.kind === "window");
    if (wins.length !== winRows.length) continue;
    if (wins.length === 1 && wins[0].ours.length === hunk.ours.length && wins[0].theirs.length === hunk.theirs.length) continue;
    const out: string[] = [];
    let wi = 0, ok = true;
    for (const e of elements) {
      if (e.kind === "anchor") { out.push(...e.lines); continue; }
      const synth: ConflictHunk = { startLine: 0, endLine: 0, oursLabel: "", theirsLabel: "", ours: e.ours, theirs: e.theirs, base: e.base };
      const lines = candidateLines(synth, winRows[wi++].pick as CandidateKind);
      if (!lines) { ok = false; break; }
      out.push(...lines);
    }
    if (ok) return out;
  }
  return null;
};

let icHunks = 0, reconstructed = 0;
const fileStats = new Map<string, { created: number; inherited: number }>();
const perFile = new Map<string, string>(); // key → verdict note
for (const row of rows) {
  const icIdx = row.hunks.map((h: any, i: number) => (h.reason === "invalid-composition" ? i : -1)).filter((i: number) => i >= 0);
  if (!icIdx.length) continue;
  const e = corpus.get(`${row.merge}|${row.path}`);
  if (!e?.conflicted) continue;
  const parsed = parseConflicts(e.conflicted);
  // reconstruct every applied hunk's lines (for cross-hunk sharing) + vetoed candidates
  const appliedLines = new Map<number, string[]>();
  const vetoedLines = new Map<number, string[]>();
  for (let i = 0; i < row.hunks.length; i++) {
    const h = row.hunks[i], hk = parsed.hunks[i];
    if (!hk) continue;
    if (h.action === "apply") {
      const ls = h.candidate === "spliced" ? (h.perLine || !h.windows ? null : splicedLines(hk, h.windows)) : candidateLines(hk, h.candidate);
      if (ls) appliedLines.set(i, ls);
    } else if (h.reason === "invalid-composition") {
      icHunks++;
      // pre-veto candidate: spliced via windows, else flat pick
      const ls = h.windows ? splicedLines(hk, h.windows) : h.pick ? candidateLines(hk, h.pick) : null;
      if (ls) { vetoedLines.set(i, ls); reconstructed++; }
    }
  }
  let created = 0, inherited = 0;
  for (const [i, ls] of vetoedLines) {
    const hk = parsed.hunks[i];
    // triggering windows: internal dups + shared with other applied/vetoed candidates
    const internal = [...dupWindows(ls)];
    const others = [...appliedLines.entries(), ...vetoedLines.entries()].filter(([j]) => j !== i);
    const shared = new Set<string>();
    for (const [, ol] of others) for (const w of sharedWindows(ls, ol)) shared.add(w);
    const triggers = new Set([...internal, ...shared]);
    if (!triggers.size) { inherited++; continue; } // can't attribute → assume inherited (conservative)
    let allInherited = true;
    for (const w of triggers) {
      // inherited iff some single side's text already contains w ≥2 times
      // (for cross-hunk: a side containing it in both regions counts as ≥2 globally)
      const oN = countWindows(hk.ours, w) + parsed.hunks.filter((h, j) => j !== i).reduce((n, h2) => n + countWindows(h2.ours, w), 0);
      const tN = countWindows(hk.theirs, w) + parsed.hunks.filter((h, j) => j !== i).reduce((n, h2) => n + countWindows(h2.theirs, w), 0);
      if (oN < 2 && tN < 2) { allInherited = false; break; }
    }
    if (allInherited) inherited++; else created++;
  }
  fileStats.set(`${row.merge}|${row.path}`, { created, inherited });
}

const files = [...fileStats.entries()];
const anyCreated = files.filter(([, s]) => s.created > 0);
console.log(JSON.stringify({
  icHunks,
  reconstructedVetoedCandidates: reconstructed,
  filesWithIc: files.length,
  filesAllInherited_falseVeto: files.filter(([, s]) => s.created === 0).length,
  filesWithCreated_realDefect: anyCreated.length,
}, null, 2));
for (const [k, s] of anyCreated) console.log(`created\t${k}\tcreated=${s.created} inherited=${s.inherited}`);
for (const [k, s] of files.filter(([, s]) => s.created === 0)) console.log(`inherited\t${k}\tinherited=${s.inherited}`);
