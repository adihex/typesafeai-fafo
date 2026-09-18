import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOrDie } from "./git.ts";
import { fmtDuration, progress } from "./ui.ts";

/**
 * Harvest real merge conflicts from a repo's history. For each merge commit
 * we re-run the merge via `git merge-tree --write-tree`, rebuild conflicted
 * files with `git merge-file`, and record the human's resolution as truth.
 */
export interface DigEntry {
  merge: string;
  path: string;
  oursLabel: string;
  theirsLabel: string;
  /** Conflicted file text with markers (diff3 style). */
  conflicted: string;
  /** Human's resolved file at the merge commit; null when deleted or when
   *  no ground truth exists (open PRs). */
  resolved: string | null;
  /** Present on PR-mode entries: no recorded resolution exists. */
  pr?: number;
  title?: string;
  base?: string;
}

interface ConflictedFileInfo {
  stage: number;
  oid: string;
  path: string;
}

function parseMergeTree(out: string): { conflicts: ConflictedFileInfo[] } {
  const lines = out.split("\n");
  // Section layout: tree OID / blank / conflicted-file-info / blank / messages.
  const conflicts: ConflictedFileInfo[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const m = line.match(/^\d+ ([0-9a-f]{40}) (\d)\t(.+)$/);
    if (m) conflicts.push({ oid: m[1], stage: Number(m[2]), path: m[3] });
  }
  return { conflicts };
}

/**
 * Group merge-tree conflicted-file-info by path and rebuild each file's
 * conflicted text via `git merge-file`. Yields only text conflicts
 * (stages 2+3 both present — modify/delete pairs are skipped).
 */
function* rebuildConflictedFiles(
  repo: string,
  dir: string,
  conflicts: ConflictedFileInfo[],
  oursLabel: string,
  theirsLabel: string,
): Generator<{ path: string; conflicted: string }> {
  const byPath = new Map<string, Map<number, string>>();
  for (const c of conflicts) {
    if (!byPath.has(c.path)) byPath.set(c.path, new Map());
    byPath.get(c.path)!.set(c.stage, c.oid);
  }

  for (const [path, stages] of byPath) {
    const ours = stages.get(2);
    const theirs = stages.get(3);
    if (!ours || !theirs) continue; // modify/delete etc.: no text conflict
    const baseOid = stages.get(1);

    const fOurs = join(dir, "ours");
    const fBase = join(dir, "base");
    const fTheirs = join(dir, "theirs");
    writeFileSync(fOurs, gitOrDie(["cat-file", "blob", ours], repo));
    writeFileSync(fTheirs, gitOrDie(["cat-file", "blob", theirs], repo));
    writeFileSync(fBase, baseOid ? gitOrDie(["cat-file", "blob", baseOid], repo) : "");

    const mf = git(
      ["merge-file", "-p", "--diff3", "-L", oursLabel, "-L", "base", "-L", theirsLabel, fOurs, fBase, fTheirs],
      repo,
    );
    if (mf.code < 0 || !mf.out.includes("<<<<<<<")) continue;
    yield { path, conflicted: mf.out };
  }
}

export async function cmdDig(o: {
  repo: string;
  out?: string;
  limit?: number;
}): Promise<number> {
  const merges = gitOrDie(["log", "--merges", "--format=%H"], o.repo)
    .split("\n")
    .filter(Boolean)
    .slice(0, o.limit ?? 50);
  if (!merges.length) {
    console.error("no merge commits found");
    return 0;
  }

  const dir = mkdtempSync(join(tmpdir(), "fafo-dig-"));
  let emitted = 0;
  const startedAt = Date.now();

  for (const [mi, merge] of merges.entries()) {
    const parents = gitOrDie(["rev-list", "--parents", "-n1", merge], o.repo)
      .trim()
      .split(" ");
    if (parents.length < 3) continue; // octopus: skip
    const [, p1, p2] = parents;

    const mt = git(["merge-tree", "--write-tree", p1, p2], o.repo);
    if (mt.code !== 1) continue; // 0=clean, 1=conflicts, other=error — only 1 teaches us anything
    const { conflicts } = parseMergeTree(mt.out);
    const conflictedFiles = new Set(conflicts.map((c) => c.path)).size;
    console.error(
      `${progress(mi + 1, merges.length, startedAt)} ${merge.slice(0, 8)}: ${conflictedFiles} conflicted file(s)`,
    );

    for (const { path, conflicted } of rebuildConflictedFiles(
      o.repo,
      dir,
      conflicts,
      p1.slice(0, 12),
      p2.slice(0, 12),
    )) {
      const truth = git(["show", `${merge}:${path}`], o.repo);
      const entry: DigEntry = {
        merge,
        path,
        oursLabel: p1.slice(0, 12),
        theirsLabel: p2.slice(0, 12),
        conflicted,
        resolved: truth.code === 0 ? truth.out : null,
      };
      const line = JSON.stringify(entry);
      if (o.out) appendFileSync(o.out, line + "\n");
      else console.log(line);
      emitted++;
    }
  }

  console.error(
    `dug ${emitted} conflicted file(s) from ${merges.length} merge(s) in ${fmtDuration(Date.now() - startedAt)}`,
  );
  return 0;
}

interface PrInfo {
  number: number;
  title: string;
  headRefOid: string;
  baseRefName: string;
}

function ghOpenPrs(repo: string, limit: number): PrInfo[] {
  const url = gitOrDie(["remote", "get-url", "origin"], repo).trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`can't parse github slug from origin: ${url}`);
  const r = spawnSync(
    "gh",
    ["pr", "list", "-R", m[1], "--state", "open", "--limit", String(limit), "--json", "number,title,headRefOid,baseRefName"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`gh pr list failed: ${r.stderr?.trim()}`);
  return JSON.parse(r.stdout) as PrInfo[];
}

/**
 * Live-fire mode: for every open PR on the repo, re-run the merge of the
 * PR head into its base ref and harvest the conflicts. There is no human
 * resolution yet, so `resolved` is always null — the eval question is
 * apply-vs-escalate, not match-vs-truth.
 */
export async function cmdDigPrs(o: {
  repo: string;
  out?: string;
  limit?: number;
  fetch?: boolean;
}): Promise<number> {
  if (o.fetch !== false) {
    const f = git(["fetch", "origin", "+refs/pull/*/head:refs/remotes/pr/*"], o.repo);
    if (f.code !== 0) console.error(`warn: pr ref fetch failed: ${f.err.trim()}`);
  }
  const prs = ghOpenPrs(o.repo, o.limit ?? 200);
  if (!prs.length) {
    console.error("no open PRs found");
    return 0;
  }

  // Make sure every base ref resolves locally.
  for (const b of new Set(prs.map((p) => p.baseRefName))) {
    if (git(["rev-parse", "--verify", `origin/${b}`], o.repo).code !== 0) {
      git(["fetch", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`], o.repo);
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "fafo-dig-prs-"));
  let emitted = 0;
  let clean = 0;
  let errors = 0;
  let conflictedPrs = 0;

  for (const pr of prs) {
    if (git(["cat-file", "-e", pr.headRefOid], o.repo).code !== 0) {
      const f = git(["fetch", "origin", pr.headRefOid], o.repo);
      if (f.code !== 0) {
        console.error(`pr${pr.number}: head ${pr.headRefOid.slice(0, 12)} unfetchable: ${f.err.trim()}`);
        errors++;
        continue;
      }
    }

    const mt = git(["merge-tree", "--write-tree", `origin/${pr.baseRefName}`, pr.headRefOid], o.repo);
    if (mt.code === 0) {
      clean++;
      continue;
    }
    if (mt.code !== 1) {
      console.error(`pr${pr.number}: merge-tree failed (${mt.code}): ${(mt.err || mt.out).trim().split("\n")[0]}`);
      errors++;
      continue;
    }
    conflictedPrs++;
    const { conflicts } = parseMergeTree(mt.out);
    const prLabel = `pr${pr.number}`;

    for (const { path, conflicted } of rebuildConflictedFiles(
      o.repo,
      dir,
      conflicts,
      pr.baseRefName,
      prLabel,
    )) {
      const entry: DigEntry = {
        merge: `${pr.baseRefName}+${prLabel}`,
        path,
        oursLabel: pr.baseRefName,
        theirsLabel: prLabel,
        conflicted,
        resolved: null,
        pr: pr.number,
        title: pr.title,
        base: pr.baseRefName,
      };
      const line = JSON.stringify(entry);
      if (o.out) appendFileSync(o.out, line + "\n");
      else console.log(line);
      emitted++;
    }
  }

  console.error(
    `prs: ${prs.length} open, ${clean} merge clean, ${conflictedPrs} conflicted, ${errors} error(s) → ${emitted} conflicted file(s)`,
  );
  return 0;
}
