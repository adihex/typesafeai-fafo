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
  /** Human's resolved file at the merge commit; null when deleted. */
  resolved: string | null;
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
    console.error(
      `${progress(mi + 1, merges.length, startedAt)} ${merge.slice(0, 8)}: ${conflicts.length} conflicted file(s)`,
    );

    // Group stage entries by path.
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
      writeFileSync(fOurs, gitOrDie(["cat-file", "blob", ours], o.repo));
      writeFileSync(fTheirs, gitOrDie(["cat-file", "blob", theirs], o.repo));
      writeFileSync(fBase, baseOid ? gitOrDie(["cat-file", "blob", baseOid], o.repo) : "");

      const mf = git(
        ["merge-file", "-p", "--diff3", "-L", p1.slice(0, 12), "-L", "base", "-L", p2.slice(0, 12), fOurs, fBase, fTheirs],
        o.repo,
      );
      if (mf.code < 0 || !mf.out.includes("<<<<<<<")) continue;

      const truth = git(["show", `${merge}:${path}`], o.repo);
      const entry: DigEntry = {
        merge,
        path,
        oursLabel: p1.slice(0, 12),
        theirsLabel: p2.slice(0, 12),
        conflicted: mf.out,
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
