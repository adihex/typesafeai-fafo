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
 * The enumerable resolution space for one hunk. Candidates that produce
 * identical replacement text are dropped — same output, same resolution.
 */
export function enumerateCandidates(hunk: ConflictHunk): Candidate[] {
  const all: Candidate[] = [
    { kind: "ours", description: DESCRIPTIONS.ours, lines: hunk.ours },
    { kind: "theirs", description: DESCRIPTIONS.theirs, lines: hunk.theirs },
    {
      kind: "both-ours-theirs",
      description: DESCRIPTIONS["both-ours-theirs"],
      lines: [...hunk.ours, ...hunk.theirs],
    },
    {
      kind: "both-theirs-ours",
      description: DESCRIPTIONS["both-theirs-ours"],
      lines: [...hunk.theirs, ...hunk.ours],
    },
    {
      kind: "union",
      description: DESCRIPTIONS.union,
      lines: dedupeLines(hunk.ours, hunk.theirs),
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
