import type { ConflictHunk, ParsedConflicts } from "./types.ts";

const MARKER = /^<{7}( |$)|^={7}$|^>{7}( |$)|^\|{7}( |$)/m;

export function hasConflictMarkers(text: string): boolean {
  return MARKER.test(text);
}

export class ConflictParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = "ConflictParseError";
  }
}

function label(line: string): string {
  const i = line.indexOf(" ");
  return i === -1 ? "" : line.slice(i + 1).trim();
}

/**
 * Parse git conflict markers (two-way `<<<<<<<`/`=======`/`>>>>>>>` and
 * diff3 `|||||||` base sections). Throws ConflictParseError on unbalanced
 * markers — callers should treat that as escalate-everything.
 */
export function parseConflicts(text: string): ParsedConflicts {
  const lines = text.split("\n");
  const hunks: ConflictHunk[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("<<<<<<<")) continue;

    const hunk: ConflictHunk = {
      startLine: i,
      endLine: -1,
      oursLabel: label(lines[i]),
      theirsLabel: "",
      ours: [],
      base: null,
      theirs: [],
    };

    // section: 0 = ours, 1 = base, 2 = theirs
    let section = 0;
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.startsWith("<<<<<<<")) {
        throw new ConflictParseError("nested conflict marker", j);
      }
      if (l.startsWith("|||||||")) {
        if (section !== 0) throw new ConflictParseError("base marker out of place", j);
        section = 1;
        hunk.base = [];
        continue;
      }
      if (l.startsWith("=======")) {
        if (section === 2) throw new ConflictParseError("duplicate separator", j);
        section = 2;
        continue;
      }
      if (l.startsWith(">>>>>>>")) {
        if (section !== 2) throw new ConflictParseError("no separator in conflict", j);
        hunk.theirsLabel = label(l);
        hunk.endLine = j + 1;
        closed = true;
        i = j;
        break;
      }
      if (section === 0) hunk.ours.push(l);
      else if (section === 1) hunk.base!.push(l);
      else hunk.theirs.push(l);
    }
    if (!closed) throw new ConflictParseError("unterminated conflict", hunk.startLine);
    hunks.push(hunk);
  }

  return { lines, hunks };
}
