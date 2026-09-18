import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";

/** One `<<<<<<< … ======= … >>>>>>>` block in a conflicted file. */
export interface ConflictHunk {
  /** Index into ParsedConflicts.lines of the `<<<<<<<` marker. */
  startLine: number;
  /** Index into ParsedConflicts.lines one past the `>>>>>>>` marker. */
  endLine: number;
  /** Label after `<<<<<<<` (e.g. "HEAD"). */
  oursLabel: string;
  /** Label after `>>>>>>>`. */
  theirsLabel: string;
  /** Lines between `<<<<<<<` and `=======` (or `|||||||` when present). */
  ours: string[];
  /** Lines between `|||||||` and `=======`; null when markers are two-way. */
  base: string[] | null;
  /** Lines between `=======` and `>>>>>>>`. */
  theirs: string[];
}

export interface ParsedConflicts {
  lines: string[];
  hunks: ConflictHunk[];
}

export type CandidateKind =
  | "ours"
  | "theirs"
  | "both-ours-theirs"
  | "both-theirs-ours"
  | "union"
  | "base"
  | "drop"
  | "spliced";

export interface Candidate {
  kind: CandidateKind;
  /** What this candidate means, phrased for the model. */
  description: string;
  /** Replacement lines for the conflicted region (empty for `drop`). */
  lines: string[];
}

/** Extra context a caller can supply about what each side was trying to do. */
export interface HunkContext {
  filePath?: string;
  /** Free-text description of the change on our side (e.g. commit message). */
  oursIntent?: string;
  theirsIntent?: string;
  /** Lines of surrounding context included in state. Default 15. */
  contextLines?: number;
  /** Override for state.context_before (default: lines above the hunk). */
  contextBefore?: string[];
  /** Override for state.context_after (default: lines below the hunk). */
  contextAfter?: string[];
  /** Appended to the state's situation line (e.g. sub-region framing). */
  situationSuffix?: string;
}

export type EscalationReason =
  | "not-in-candidates"
  | "novel-merge-needed"
  | "verification-failed"
  | "low-confidence"
  | "ask-failed";

/** Per-window trace left by a decomposed (spliced) decision. */
export interface WindowTrace {
  index: number;
  oursLines: number;
  theirsLines: number;
  picked?: string;
  confidence?: number;
  coverage?: number;
  action: "apply" | "escalate";
  reason?: EscalationReason;
}

export interface Decision {
  action: "apply" | "escalate";
  /** Present when action is "apply". */
  candidate?: Candidate;
  reason?: EscalationReason;
  /** Raw signals, kept for evaluation. */
  detail: {
    picked?: string;
    confidence?: number;
    coverage?: number;
    verify: Record<string, number>;
    probabilities?: Record<string, number>;
    /** Error message when the ask itself failed. */
    error?: string;
    /** Per-window outcomes when the decision came from decomposition. */
    windows?: WindowTrace[];
    /** Whole-hunk verdict that triggered decomposition. */
    wholeHunkReason?: EscalationReason;
  };
}

export interface HunkOutcome {
  hunkIndex: number;
  hunk: ConflictHunk;
  decision: Decision;
  /** Token usage for the Jev call, when the asker reports it. */
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ResolveResult {
  /** File text with applied candidates spliced in; escalated hunks keep markers. */
  text: string;
  outcomes: HunkOutcome[];
  applied: number;
  escalated: number;
}

export interface ResolveOptions extends HunkContext {
  /** Below this Choice confidence, escalate. Default 0.5. */
  minConfidence?: number;
  /** Below this coverage noul, escalate as not-in-candidates. Default 0.5. */
  minCoverage?: number;
  /** Below this per-candidate verify noul, the winner is rejected. Default 0.5. */
  minVerify?: number;
  /** Skip per-candidate verification nouls. Default false. */
  noVerify?: boolean;
  /** Model override passed through to the request. */
  model?: string;
  /** Retry escalated hunks as per-window sub-conflicts. Default true. */
  decompose?: boolean;
  /** Max windows a hunk may split into before giving up. Default 12. */
  maxWindows?: number;
}

/** The one impure seam: everything else in core is pure. */
export type Asker = (
  request: SystemOneRequest<Questions>,
) => Promise<SystemOneResult<Questions>>;
