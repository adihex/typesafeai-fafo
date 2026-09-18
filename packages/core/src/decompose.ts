import type { ConflictHunk } from "./types.ts";

/**
 * Intra-hunk decomposition: align ours vs theirs so a conflicted region
 * splits into shared "anchor" lines and minimal "windows" of disagreement.
 * Each window is enumerable by the flat candidate set, which makes
 * line-level interleavings — the dominant not-in-candidates failure —
 * expressible. For diff3 hunks each window also recovers the base lines it
 * replaced, via base→side alignments.
 */

export interface Anchor {
  kind: "anchor";
  /** Lines both versions share verbatim at this position. */
  lines: string[];
}

export interface Window {
  kind: "window";
  ours: string[];
  theirs: string[];
  /** Base lines this window replaced; null for two-way hunks. */
  base: string[] | null;
}

export type Element = Anchor | Window;

export interface DecomposedHunk {
  /** Ordered anchors + windows; concatenating window replacements with
   *  anchors reconstructs a full resolution for the hunk. */
  elements: Element[];
  windows: number;
}

const key = (l: string) => l.replace(/\s+$/, "");

const eqSpan = (a: string[], b: string[]) =>
  a.length === b.length && a.every((l, i) => key(l) === key(b[i]));

/** LCS match pairs between a and b as increasing index tuples. */
export function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [];
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] =
        key(a[i]) === key(b[j])
          ? t[(i + 1) * w + j + 1] + 1
          : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(a[i]) === key(b[j])) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** bi of the last pair whose side-index is < pos, else -1. */
function prevBoundary(pairs: Array<[number, number]>, pos: number): number {
  let lo = 0;
  let hi = pairs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pairs[mid][1] < pos) {
      ans = pairs[mid][0];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** bi of the first pair whose side-index is >= pos, else fallback. */
function nextBoundary(
  pairs: Array<[number, number]>,
  pos: number,
  fallback: number,
): number {
  let lo = 0;
  let hi = pairs.length - 1;
  let ans = fallback;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pairs[mid][1] >= pos) {
      ans = pairs[mid][0];
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return ans;
}

/**
 * Base lines covered by the window spanning ours[o1..o2) / theirs[t1..t2):
 * the union of the base ranges each side's alignment says it replaced.
 */
function baseSpanForWindow(
  base: string[],
  oPairs: Array<[number, number]>,
  tPairs: Array<[number, number]>,
  o1: number,
  o2: number,
  t1: number,
  t2: number,
): string[] {
  const lo = Math.min(prevBoundary(oPairs, o1), prevBoundary(tPairs, t1)) + 1;
  const hi = Math.max(
    nextBoundary(oPairs, o2, base.length),
    nextBoundary(tPairs, t2, base.length),
  );
  return base.slice(lo, hi);
}

/**
 * Windows separated by fewer than `minAnchor` shared lines are merged so
 * Jev sees coherent regions instead of choppy one-line decisions.
 */
function mergeShortAnchors(elements: Element[], minAnchor: number): void {
  for (let i = 1; i < elements.length - 1; i++) {
    const e = elements[i];
    if (e.kind !== "anchor" || e.lines.length >= minAnchor) continue;
    const prev = elements[i - 1];
    const next = elements[i + 1];
    if (prev.kind !== "window" || next.kind !== "window") continue;
    prev.ours = [...prev.ours, ...e.lines, ...next.ours];
    prev.theirs = [...prev.theirs, ...e.lines, ...next.theirs];
    prev.base =
      prev.base === null || next.base === null
        ? null
        : [...prev.base, ...e.lines, ...next.base];
    elements.splice(i, 2);
    i--;
  }
}

/**
 * Split a hunk into anchors + windows by aligning ours↔theirs. When the
 * hunk carries diff3 base, each window also gets the base lines it
 * replaced (as a window-level `base` candidate).
 */
export function decomposeHunk(hunk: ConflictHunk, minAnchor = 3): DecomposedHunk {
  const elements: Element[] = [];
  const pairs = lcsPairs(hunk.ours, hunk.theirs);
  const oPairs = hunk.base === null ? [] : lcsPairs(hunk.base, hunk.ours);
  const tPairs = hunk.base === null ? [] : lcsPairs(hunk.base, hunk.theirs);

  const pushWindow = (o1: number, o2: number, t1: number, t2: number) => {
    const ours = hunk.ours.slice(o1, o2);
    const theirs = hunk.theirs.slice(t1, t2);
    if (eqSpan(ours, theirs)) {
      if (ours.length) elements.push({ kind: "anchor", lines: ours });
      return;
    }
    const base =
      hunk.base === null
        ? null
        : baseSpanForWindow(hunk.base, oPairs, tPairs, o1, o2, t1, t2);
    elements.push({ kind: "window", ours, theirs, base });
  };

  let po = 0;
  let pt = 0;
  for (const [oi, ti] of pairs) {
    pushWindow(po, oi, pt, ti);
    elements.push({ kind: "anchor", lines: [hunk.ours[oi]] });
    po = oi + 1;
    pt = ti + 1;
  }
  pushWindow(po, hunk.ours.length, pt, hunk.theirs.length);

  mergeShortAnchors(elements, minAnchor);
  return { elements, windows: elements.filter((e) => e.kind === "window").length };
}
