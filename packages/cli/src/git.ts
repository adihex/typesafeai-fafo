import { spawnSync } from "node:child_process";

/** Run git, tolerate nonzero exits that carry meaning (e.g. merge-file). */
export function git(args: string[], cwd?: string): { code: number; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

export function gitOrDie(args: string[], cwd?: string): string {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${r.err.trim()}`);
  return r.out;
}

export function conflictedPaths(cwd: string): string[] {
  const out = gitOrDie(["diff", "--name-only", "-z", "--diff-filter=U"], cwd);
  return out.split("\0").filter(Boolean);
}
