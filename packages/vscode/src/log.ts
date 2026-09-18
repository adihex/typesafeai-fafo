import * as vscode from "vscode";
import type { HunkOutcome } from "@fafo/core";

function fmt(n: number | undefined): string {
  return n === undefined ? "-" : n.toFixed(2);
}

/** Audit trail: one line per hunk decision, plus window traces for splices. */
export class FafoLog implements vscode.Disposable {
  private ch = vscode.window.createOutputChannel("FAFO Resolve");

  line(msg: string): void {
    this.ch.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  outcome(file: string, o: HunkOutcome): void {
    const d = o.decision;
    const usage = o.usage
      ? ` · tok ${o.usage.input_tokens}→${o.usage.output_tokens}`
      : "";
    if (d.action === "apply") {
      const ver = d.candidate ? d.detail.verify[d.candidate.kind] : undefined;
      this.line(
        `${file} hunk${o.hunkIndex}: apply ${d.candidate?.kind} conf=${fmt(d.detail.confidence)} cov=${fmt(d.detail.coverage)} verify=${fmt(ver)}${usage}`,
      );
    } else {
      const err = d.detail.error ? ` — ${d.detail.error}` : "";
      const whole = d.detail.wholeHunkReason
        ? ` (whole-hunk: ${d.detail.wholeHunkReason})`
        : "";
      this.line(`${file} hunk${o.hunkIndex}: ESCALATED ${d.reason}${whole}${err}${usage}`);
    }
    for (const w of d.detail.windows ?? []) {
      const what =
        w.action === "apply"
          ? `apply ${w.picked} conf=${fmt(w.confidence)} cov=${fmt(w.coverage)}`
          : `escalate ${w.reason}`;
      this.line(`  window${w.index} [${w.oursLines}o/${w.theirsLines}t]: ${what}`);
    }
  }

  show(): void {
    this.ch.show(true);
  }

  dispose(): void {
    this.ch.dispose();
  }
}
