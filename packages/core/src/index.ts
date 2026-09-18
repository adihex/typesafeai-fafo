export { enumerateCandidates } from "./candidates.ts";
export { interpret } from "./interpret.ts";
export { ConflictParseError, hasConflictMarkers, parseConflicts } from "./parse.ts";
export {
  buildHunkRequest,
  buildState,
  COVERED,
  NOVEL,
  PICK,
  verifyKey,
} from "./questions.ts";
export { resolveText } from "./resolve.ts";
export type {
  Asker,
  Candidate,
  CandidateKind,
  ConflictHunk,
  Decision,
  EscalationReason,
  HunkContext,
  HunkOutcome,
  ParsedConflicts,
  ResolveOptions,
  ResolveResult,
} from "./types.ts";
