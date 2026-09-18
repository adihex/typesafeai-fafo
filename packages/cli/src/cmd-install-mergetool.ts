import { existsSync } from "node:fs";
import { delimiter, isAbsolute, resolve as resolvePath } from "node:path";
import { git, gitOrDie } from "./git.ts";

/**
 * Register fafo-resolve as a git mergetool. `git mergetool` invokes the
 * configured cmd once per conflicted file with $MERGED pointing at the
 * working-tree file that carries conflict markers; exit 0 means resolved,
 * nonzero means still conflicted — which is exactly `resolve`'s contract.
 */

export interface InstallMergetoolOpts {
  /** Write repo-local config instead of --global. */
  local?: boolean;
  /** Also set merge.conflictStyle=diff3 (gives the resolver a BASE section). */
  diff3?: boolean;
  /** Override the command git runs; "$MERGED" is appended context. */
  cmd?: string;
  cwd: string;
}

function onPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(`${dir}/${name}`)) return true;
  }
  return false;
}

/** Best-effort command line for the mergetool to invoke. */
function resolveCmd(): string {
  if (onPath("fafo-resolve")) return `fafo-resolve resolve "$MERGED"`;
  // Running via tsx on the raw source: pin the absolute path so the
  // mergetool works from any repo regardless of PATH.
  const script = process.argv[1];
  if (script && script.endsWith(".ts")) {
    const abs = isAbsolute(script) ? script : resolvePath(process.cwd(), script);
    return `npx tsx "${abs}" resolve "$MERGED"`;
  }
  return `fafo-resolve resolve "$MERGED"`;
}

export async function cmdInstallMergetool(o: InstallMergetoolOpts): Promise<number> {
  const scope = o.local ? "--local" : "--global";
  if (o.local) {
    const inside = git(["rev-parse", "--is-inside-work-tree"], o.cwd);
    if (inside.code !== 0 || inside.out.trim() !== "true") {
      console.error("--local requires being inside a git work tree");
      return 2;
    }
  }

  if (o.cmd && !o.cmd.trimEnd().endsWith('resolve "$MERGED"')) {
    console.error(
      `--cmd must end with 'resolve "$MERGED"' (got: ${o.cmd}) — ` +
        `git invokes it as <cmd> and the exit code is the per-file verdict.`,
    );
    return 2;
  }

  const cmd = o.cmd ?? resolveCmd();
  const entries: Array<[string, string]> = [
    ["merge.tool", "fafo"],
    ["mergetool.fafo.cmd", cmd],
    ["mergetool.fafo.trustExitCode", "true"],
  ];
  if (o.diff3) entries.push(["merge.conflictStyle", "diff3"]);

  for (const [key, value] of entries) {
    gitOrDie(["config", scope, key, value], o.local ? o.cwd : undefined);
    console.log(`${key}=${value}`);
  }

  console.log(`
installed fafo as mergetool (${o.local ? "repo-local" : "global"}).

next steps:
  1. export TYPESAFE_API_KEY in the shell git runs in.
  2. on a merge with conflicts:  git mergetool
     (single file:  git mergetool <path>  — merge.tool already points at fafo)
  3. per file, exit 0 marks it resolved; escalated hunks keep their
     markers and git leaves the file unmerged. Re-run after edits.

backups: after a successful resolve, git keeps the pre-tool file as
  <file>.orig. To drop it instead:
    git config ${scope} mergetool.keepBackup false
  (on failure git restores the conflicted file — no .orig is left behind.)
${
  o.diff3
    ? "diff3: merge.conflictStyle=diff3 set."
    : `diff3: run 'git config ${scope} merge.conflictStyle diff3' (or --diff3 here)`
}
  so conflicts carry the BASE section — better picks, 'base' candidate.
`);
  return 0;
}
