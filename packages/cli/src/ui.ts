import type { Decision, EscalationReason } from "@fafo/core";

/** Color only on a real TTY; NO_COLOR and --json both disable it. */
export const colorize =
  process.stderr.isTTY && !process.env.NO_COLOR
    ? (code: number, s: string) => `\u001b[${code}m${s}\u001b[0m`
    : (_code: number, s: string) => s;

export const bold = (s: string) => colorize(1, s);
export const dim = (s: string) => colorize(2, s);
export const green = (s: string) => colorize(32, s);
export const yellow = (s: string) => colorize(33, s);
export const red = (s: string) => colorize(31, s);
export const cyan = (s: string) => colorize(36, s);

export const sym = {
  apply: green("✓"),
  escalate: yellow("!"),
  file: cyan("▸"),
} as const;

const REASON_TEXT: Record<EscalationReason, { short: string; hint: string }> = {
  "not-in-candidates": {
    short: "no candidate satisfied Jev",
    hint: "the right answer likely isn't enumerated — probably needs a novel merge",
  },
  "novel-merge-needed": {
    short: "needs a novel merge",
    hint: "Jev signalled that both sides must be woven together by hand",
  },
  "verification-failed": {
    short: "pick failed verification",
    hint: "Jev picked a candidate then rejected it on a second look",
  },
  "discards-work": {
    short: "would silently drop real work",
    hint: "a borderline single-side pick was caught discarding lines that matter",
  },
  "low-confidence": {
    short: "Jev wouldn't commit",
    hint: "confidence below threshold — the hunk is genuinely ambiguous",
  },
  "ask-failed": {
    short: "Jev request failed",
    hint: "API error, not a judgment — safe to retry",
  },
};

export const reasonShort = (r: EscalationReason) => REASON_TEXT[r]?.short ?? r;

const f2 = (n: number | undefined) => (n === undefined ? "—" : n.toFixed(2));

/** One-line rendering of a hunk decision for humans. */
export function fmtOutcome(hunkIndex: number, d: Decision): string {
  if (d.action === "apply") {
    const via = d.detail.perLine
      ? "per-line"
      : d.detail.headToHead
        ? "head-to-head"
        : d.detail.secondOpinion
          ? "2nd-opinion"
          : d.detail.windows
            ? `${d.detail.windows.length} windows`
            : null;
    return (
      `${sym.apply} hunk${hunkIndex}: ${bold(d.candidate!.kind)}` +
      dim(` (conf ${f2(d.detail.confidence)} · cov ${f2(d.detail.coverage)}`) +
      (via ? dim(` · via ${via}`) : "") +
      dim(")")
    );
  }
  const picked = d.detail.picked ? `, leaned ${d.detail.picked} @ ${f2(d.detail.confidence)}` : "";
  return (
    `${sym.escalate} hunk${hunkIndex}: ${yellow("escalated")} — ${d.reason}` +
    dim(` (${reasonShort(d.reason!)}${picked})`)
  );
}

/** Verbose extras: window traces + raw gate scores for a decision. */
export function fmtOutcomeVerbose(d: Decision): string[] {
  const out: string[] = [];
  if (d.detail.wholeHunkReason) {
    out.push(dim(`    whole-hunk: ${d.detail.wholeHunkReason} → decomposed`));
  }
  for (const w of d.detail.windows ?? []) {
    const what =
      w.action === "apply" ? `${w.picked} (conf ${f2(w.confidence)})` : `escalated ${w.reason}`;
    out.push(dim(`    win${w.index}: ${what} [${w.oursLines} ours / ${w.theirsLines} theirs]`));
  }
  const verify = Object.entries(d.detail.verify ?? {});
  if (verify.length && d.action === "escalate") {
    out.push(dim(`    verify: ${verify.map(([k, v]) => `${k.replace("verify_", "")}=${f2(v)}`).join(" ")}`));
  }
  if (d.detail.discard) {
    out.push(
      dim(`    discard: ${Object.entries(d.detail.discard).map(([k, v]) => `${k.replace("discard_", "")}=${f2(v)}`).join(" ")}`),
    );
  }
  if (d.detail.error) out.push(dim(`    error: ${d.detail.error}`));
  return out;
}

/** "2 low-confidence, 1 not-in-candidates" — empty string when none. */
export function reasonBreakdown(reasons: (EscalationReason | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].map(([r, n]) => `${n} ${r}`).join(", ");
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** Stderr progress ticker: "[12/160 · 1m3s · ~4m left]" — cheap, no redraw. */
export function progress(i: number, total: number, startedAt: number): string {
  const el = Date.now() - startedAt;
  const eta = i > 2 ? ` · ~${fmtDuration(Math.round((el / i) * (total - i)))} left` : "";
  return dim(`[${i}/${total} · ${fmtDuration(el)}${eta}]`);
}
