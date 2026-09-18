// Blast-radius scan: reconstruct composed output for v3 applied hunks from
// RECORDED decisions only (no re-asks), then scan for cross-hunk
// contradictions: (a) identifier added by one hunk but dropped by another,
// (b) the same block applied into two different conflict regions, plus
// (c) invalid JSON in fully-applied .json files. Emits composed files for
// external syntax checks (esbuild/plutil).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decomposeHunk,
  enumerateCandidates,
  parseConflicts,
  type CandidateKind,
  type ConflictHunk,
  type DigEntry,
} from "@fafo/core";

const [corpusPath = ".auto/corpus-prs.jsonl", evalPath = ".auto/eval-prs-v3.json", outDir = "/tmp/blast"] = process.argv.slice(2);

const corpus = new Map<string, DigEntry>();
for (const line of readFileSync(corpusPath, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as DigEntry;
  corpus.set(`${e.merge}|${e.path}`, e);
}
const rows = (JSON.parse(readFileSync(evalPath, "utf8")) as any).rows as any[];

/** Candidate lines for a non-spliced recorded apply. */
function candidateLines(hunk: ConflictHunk, kind: CandidateKind): string[] | null {
  return enumerateCandidates(hunk).find((c) => c.kind === kind)?.lines ?? null;
}

/** Reconstruct a recorded spliced apply by replaying window picks over the
 *  decomposition whose window count matches the trace. */
function splicedLines(hunk: ConflictHunk, winRows: { pick: string }[]): string[] | null {
  for (const minAnchor of [1, 3, 8]) {
    const { elements } = decomposeHunk(hunk, minAnchor);
    const wins = elements.filter((e) => e.kind === "window");
    if (wins.length !== winRows.length) continue;
    if (wins.length === 1 && wins[0].ours.length === hunk.ours.length && wins[0].theirs.length === hunk.theirs.length) continue;
    const out: string[] = [];
    let wi = 0;
    let ok = true;
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
}

const STOP = new Set(("return,const,let,var,function,if,else,for,while,do,switch,case,break,continue,new,this,null,undefined,true,false,await,async,typeof,instanceof,import,from,export,default,class,extends,interface,type,enum,public,private,protected,static,readonly,void,any,string,number,boolean,object,unknown,never,get,set,in,of,is,as,keyof,catch,try,finally,throw,throws,yield,delete,data,name,value,key,item,index,error,result,response,request,options,config,args,params,props,state,id,ids,user,users,node,list,items,map,array,record,json,body,text,path,file,line,lines,end,start,next,prev,all,any,each,self,call,apply,bind,length,size,count,push,pop,shift,slice,split,join,trim,log,info,warn,debug,error,then,catch,Promise,Array,Object,String,Number,Boolean,JSON,Math,Date,console,process,require,module,exports,undefined,stringify,parse,string,int,bool,long,short,byte,char,float,double,def,val,fun,func,fn,elif,endif,elifdef,include,using,namespace,struct,impl,trait,where,mut,ref,self,super,package,final,override,virtual,template,typename,auto,nil,true,false,guard,defer,some,none,case,guard,init,weak,unowned,lazy,var,let,func,return,if,else,for,while,switch,case,break,continue,default,do,catch,try,throw,throws,rethrows,async,await,actor,nonisolated,private,fileprivate,internal,public,open,static,class,struct,enum,protocol,extension,import,func,associatedtype,typealias,operator,precedencegroup,inout,subscript,convenience,required,dynamic,optional").split(","));

interface HunkApplied { i: number; kind: string; lines: string[] }
interface FileScan {
  merge: string; path: string; verdict: string;
  applied: HunkApplied[]; unreconstructable: number;
  composed: string[] | null;
}

const files: FileScan[] = [];
let nUnrecHunks = 0;
for (const row of rows) {
  const e = corpus.get(`${row.merge}|${row.path}`);
  if (!e?.conflicted) continue;
  const parsed = parseConflicts(e.conflicted);
  const applied: HunkApplied[] = [];
  let unrec = 0;
  for (let i = 0; i < row.hunks.length; i++) {
    const h = row.hunks[i];
    if (h.action !== "apply") continue;
    const hk = parsed.hunks[i];
    if (!hk) { unrec++; continue; }
    let lines: string[] | null;
    if (h.candidate === "spliced") {
      lines = h.perLine || !h.windows ? null : splicedLines(hk, h.windows);
    } else {
      lines = candidateLines(hk, h.candidate);
    }
    if (lines) applied.push({ i, kind: h.candidate, lines });
    else { unrec++; nUnrecHunks++; }
  }
  // Compose full file text when every hunk resolved to lines (applied or
  // escalated — escalated keeps its original marker text).
  let composed: string[] | null = null;
  if (unrec === 0) {
    const out: string[] = [];
    let cursor = 0;
    let okAll = true;
    for (let i = 0; i < parsed.hunks.length; i++) {
      const hk = parsed.hunks[i];
      out.push(...parsed.lines.slice(cursor, hk.startLine));
      const rec = row.hunks[i];
      if (rec.action === "apply") {
        const a = applied.find((x) => x.i === i);
        if (!a) { okAll = false; break; }
        out.push(...a.lines);
      } else {
        out.push(...parsed.lines.slice(hk.startLine, hk.endLine));
      }
      cursor = hk.endLine;
    }
    if (okAll) { out.push(...parsed.lines.slice(cursor)); composed = out; }
  }
  files.push({ merge: row.merge, path: row.path, verdict: row.verdict, applied, unreconstructable: unrec, composed });
}

// ---- check (b): duplicated block across applied hunks --------------------
const substantive = (l: string) => l.trim().length >= 3 && !/^[{}()[\];,]+$/.test(l.trim());
function longestSharedRun(a: string[], b: string[]): string[] {
  // longest contiguous run of identical substantive lines
  let best: string[] = [];
  const bIdx = new Map<string, number[]>();
  b.forEach((l, i) => { const k = l.trim(); if (!bIdx.has(k)) bIdx.set(k, []); bIdx.get(k)!.push(i); });
  for (let i = 0; i < a.length; i++) {
    const k = a[i].trim();
    if (!substantive(k)) continue;
    for (const j of bIdx.get(k) ?? []) {
      let len = 0;
      while (i + len < a.length && j + len < b.length && a[i + len].trim() === b[j + len].trim() && substantive(a[i + len])) len++;
      if (len > best.length) best = a.slice(i, i + len);
    }
  }
  return best;
}
const hasRun = (hay: string[], run: string[]) => {
  if (!run.length) return false;
  outer: for (let i = 0; i + run.length <= hay.length; i++) {
    for (let k = 0; k < run.length; k++) if (hay[i + k].trim() !== run[k].trim()) continue outer;
    return true;
  }
  return false;
};

// ---- check (a): identifier added by one hunk, dropped by another ---------
const ID = /\b[a-zA-Z_$][a-zA-Z0-9_$]{3,}\b/g;
// "Code-shaped" identifiers only: camelCase (internal capital), snake_case
// or $, or PascalCase ≥8 chars — plain English words are the noise floor.
const codeish = (t: string) =>
  /[a-z][A-Z]/.test(t) || /[_$]/.test(t) || (/^[A-Z]/.test(t) && t.length >= 8);
const idSet = (lines: string[]) => {
  const s = new Set<string>();
  for (const l of lines) for (const m of l.matchAll(ID)) if (!STOP.has(m[0]) && codeish(m[0])) s.add(m[0]);
  return s;
};

interface Finding { merge: string; path: string; kind: "dup" | "dropped-id" | "bad-json"; detail: string }
const findings: Finding[] = [];

for (const f of files) {
  const e = corpus.get(`${f.merge}|${f.path}`)!;
  const parsed = parseConflicts(e.conflicted!);
  // need input sides per hunk for dup-justification + dropped-id
  for (let x = 0; x < f.applied.length; x++) {
    for (let y = x + 1; y < f.applied.length; y++) {
      const A = f.applied[x], B = f.applied[y];
      // (b) dup: shared run not present twice in either input side
      const run = longestSharedRun(A.lines, B.lines);
      if (run.length >= 4) {
        const hi = parsed.hunks[A.i], hj = parsed.hunks[B.i];
        const oursHadBoth = hasRun(hi.ours, run) && hasRun(hj.ours, run);
        const theirsHadBoth = hasRun(hi.theirs, run) && hasRun(hj.theirs, run);
        if (!oursHadBoth && !theirsHadBoth) {
          findings.push({ merge: f.merge, path: f.path, kind: "dup",
            detail: `hunks ${A.i}(${A.kind}) & ${B.i}(${B.kind}) share ${run.length}L: ${run.slice(0, 3).map((l) => l.trim()).join(" ⏎ ")}…` });
        }
      }
      // (a) dropped-id: X in A.applied AND dropped by B (present in one of
      // B's input sides, absent from B's applied text)
      const hj = parsed.hunks[B.i], hi = parsed.hunks[A.i];
      const inB = idSet([...hj.ours, ...hj.theirs]);
      const droppedByB = new Set([...inB].filter((t) => !idSet(B.lines).has(t)));
      const dropped = [...idSet(A.lines)].filter((t) => droppedByB.has(t));
      if (dropped.length)
        findings.push({ merge: f.merge, path: f.path, kind: "dropped-id",
          detail: `hunk ${A.i}(${A.kind}) adds ${dropped.slice(0, 5).join(",")}${dropped.length > 5 ? `+${dropped.length - 5}` : ""}; hunk ${B.i}(${B.kind}) drops it` });
      // symmetric: B adds, A drops
      const inA = idSet([...hi.ours, ...hi.theirs]);
      const droppedByA = new Set([...inA].filter((t) => !idSet(A.lines).has(t)));
      const droppedA = [...idSet(B.lines)].filter((t) => droppedByA.has(t));
      if (droppedA.length)
        findings.push({ merge: f.merge, path: f.path, kind: "dropped-id",
          detail: `hunk ${B.i}(${B.kind}) adds ${droppedA.slice(0, 5).join(",")}${droppedA.length > 5 ? `+${droppedA.length - 5}` : ""}; hunk ${A.i}(${A.kind}) drops it` });
    }
  }
  // (c) JSON parse on fully-applied .json files
  if (f.composed && f.verdict === "applied" && f.path.endsWith(".json")) {
    try { JSON.parse(f.composed.join("\n")); }
    catch (err) {
      findings.push({ merge: f.merge, path: f.path, kind: "bad-json", detail: String(err).slice(0, 140) });
    }
  }
}

mkdirSync(outDir, { recursive: true });
for (const f of files) {
  if (!f.composed) continue;
  if (!/\.(ts|tsx|js|jsx|plist|json)$/.test(f.path)) continue;
  const dest = join(outDir, f.merge.replace(/[^\w.-]/g, "_") + "__" + f.path.replace(/[^\w.-]/g, "_"));
  writeFileSync(dest, f.composed.join("\n") + "\n");
}

const appliedFiles = files.filter((f) => f.verdict === "applied");
const with2 = files.filter((f) => f.applied.length >= 2);
const flagged = new Set(findings.map((x) => `${x.merge}|${x.path}`));
console.log(JSON.stringify({
  filesTotal: files.length,
  filesApplied: appliedFiles.length,
  filesWith2PlusReconstructedHunks: with2.length,
  unreconstructableAppliedHunks: nUnrecHunks,
  composedFiles: files.filter((f) => f.composed).length,
  findings: { total: findings.length, dup: findings.filter((x) => x.kind === "dup").length, droppedId: findings.filter((x) => x.kind === "dropped-id").length, badJson: findings.filter((x) => x.kind === "bad-json").length },
  flaggedFiles: flagged.size,
}, null, 2));
for (const x of findings) console.log(`${x.kind}\t${x.merge}\t${x.path}\t${x.detail}`);
