import type { Candidate, CandidateKind, ConflictHunk } from "./types.ts";

const DESCRIPTIONS: Record<CandidateKind, string> = {
  ours: "Take the OURS version only; discard the THEIRS change.",
  theirs: "Take the THEIRS version only; discard the OURS change.",
  "both-ours-theirs": "Keep both changes: OURS lines first, then THEIRS lines.",
  "both-theirs-ours": "Keep both changes: THEIRS lines first, then OURS lines.",
  union:
    "Keep every distinct line from both versions, in OURS order then THEIRS-only lines appended.",
  base: "Restore the original BASE version; discard both changes.",
  drop: "Delete the conflicted region entirely; both versions are moot.",
  spliced:
    "Line-level merge: the conflict was split into sub-regions and each resolved separately.",
};

function dedupeLines(first: string[], second: string[]): string[] {
  const seen = new Set(first);
  const extra = second.filter((l) => {
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
  return [...first, ...extra];
}

/**
 * Verbatim line-concat can leave a trailing comma before a closing bracket —
 * invalid in JSON. Drop the comma when the next non-blank line closes a
 * bracket. Gated to .json files: in JS/TS trailing commas are legal, so
 * repairing would only diverge the text from a valid resolution.
 */
export function repairTrailingCommas(lines: string[]): string[] {
  const out = [...lines];
  for (let i = 0; i < out.length; i++) {
    if (!out[i].trimEnd().endsWith(",")) continue;
    const next = out.slice(i + 1).find((l) => l.trim() !== "");
    if (next && /^[}\])]/.test(next.trim())) {
      out[i] = out[i].replace(/,(\s*)$/, "$1");
    }
  }
  return out;
}

/**
 * The enumerable resolution space for one hunk. Candidates that produce
 * identical replacement text are dropped — same output, same resolution.
 */
export function enumerateCandidates(
  hunk: ConflictHunk,
  filePath?: string,
): Candidate[] {
  const repair = filePath?.endsWith(".json")
    ? repairTrailingCommas
    : (lines: string[]) => lines;
  const all: Candidate[] = [
    { kind: "ours", description: DESCRIPTIONS.ours, lines: hunk.ours },
    { kind: "theirs", description: DESCRIPTIONS.theirs, lines: hunk.theirs },
    {
      kind: "both-ours-theirs",
      description: DESCRIPTIONS["both-ours-theirs"],
      lines: repair([...hunk.ours, ...hunk.theirs]),
    },
    {
      kind: "both-theirs-ours",
      description: DESCRIPTIONS["both-theirs-ours"],
      lines: repair([...hunk.theirs, ...hunk.ours]),
    },
    {
      kind: "union",
      description: DESCRIPTIONS.union,
      lines: repair(dedupeLines(hunk.ours, hunk.theirs)),
    },
  ];
  if (hunk.base !== null) {
    all.push({ kind: "base", description: DESCRIPTIONS.base, lines: hunk.base });
  }
  all.push({ kind: "drop", description: DESCRIPTIONS.drop, lines: [] });

  const seen = new Set<string>();
  return all.filter((c) => {
    const key = c.lines.join("\n");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
