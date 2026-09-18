import type { ConflictHunk, ParsedConflicts } from "./types.ts";

const MARKER = /^<{7}( |$)|^={7}$|^>{7}( |$)|^\|{7}( |$)/m;
// Git emits exactly 7 marker chars; longer runs (setext underlines, ASCII
// rules) inside conflict content must not read as markers.
const OPEN = /^<{7}( |$)/;
const BASE = /^\|{7}( |$)/;
const SEP = /^={7}$/;
const CLOSE = /^>{7}( |$)/;

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
    if (!OPEN.test(lines[i])) continue;

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
      if (OPEN.test(l)) {
        throw new ConflictParseError("nested conflict marker", j);
      }
      if (BASE.test(l)) {
        if (section !== 0) throw new ConflictParseError("base marker out of place", j);
        section = 1;
        hunk.base = [];
        continue;
      }
      if (SEP.test(l)) {
        if (section === 2) throw new ConflictParseError("duplicate separator", j);
        section = 2;
        continue;
      }
      if (CLOSE.test(l)) {
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
