package core

import (
	"fmt"
	"strings"
)

const (
	PICK           = "pick"
	COVERED        = "covered"
	NOVEL          = "needs-novel-merge"
	VERIFY_SPLICED = "verify_spliced"
	DISCARD_CHECK  = "discard_check"
)

func VerifyKey(kind CandidateKind) string  { return "verify_" + string(kind) }
func DiscardKey(kind CandidateKind) string { return "discard_" + string(kind) }

// DISCARDING: candidates whose apply discards work from a side — the
// dangerous direction.
var DISCARDING = map[CandidateKind]bool{
	Ours: true, Theirs: true, Base: true, Drop: true,
}

const novelDescription = "None of the candidates is correct — resolving this conflict requires new or reworked code not present in either version."

func block(tag string, lines []string) string {
	return fmt.Sprintf("--- %s ---\n%s\n--- end %s ---", tag, strings.Join(lines, "\n"), tag)
}

// truncateLines: head+tail with an elision marker so the shape survives
// when a side is huge.
func truncateLines(lines []string, max int) []string {
	if len(lines) <= max {
		return lines
	}
	head := int(float64(max) * 0.6)
	tail := max - head
	out := append([]string{}, lines[:head]...)
	out = append(out, fmt.Sprintf("… [%d lines elided] …", len(lines)-max))
	return append(out, lines[len(lines)-tail:]...)
}

// BuildState: the three versions, surrounding context, and whatever intent
// the caller knows (branch labels, commit messages).
func BuildState(parsed *ParsedConflicts, hunk *ConflictHunk, ctx *ResolveOptions) map[string]any {
	n := ctx.contextLines()
	var before, after []string
	if ctx != nil && ctx.ContextBefore != nil {
		before = ctx.ContextBefore
	} else {
		lo := hunk.StartLine - n
		if lo < 0 {
			lo = 0
		}
		before = parsed.Lines[lo:hunk.StartLine]
	}
	if ctx != nil && ctx.ContextAfter != nil {
		after = ctx.ContextAfter
	} else {
		hi := hunk.EndLine + n
		if hi > len(parsed.Lines) {
			hi = len(parsed.Lines)
		}
		after = parsed.Lines[hunk.EndLine:hi]
	}

	situation := "A git merge produced a conflict in this file. Decide how the conflicted region should be resolved."
	if ctx != nil {
		situation += ctx.SituationSuffix
	}
	oursLabel := hunk.OursLabel
	if oursLabel == "" {
		oursLabel = "ours"
	}
	theirsLabel := hunk.TheirsLabel
	if theirsLabel == "" {
		theirsLabel = "theirs"
	}
	versions := map[string]any{
		"ours":   block("OURS ("+oursLabel+")", truncateLines(hunk.Ours, 150)),
		"theirs": block("THEIRS ("+theirsLabel+")", truncateLines(hunk.Theirs, 150)),
	}
	if hunk.Base != nil {
		versions["base"] = block("BASE (common ancestor)", truncateLines(hunk.Base, 150))
	}
	state := map[string]any{
		"situation":      situation,
		"versions":       versions,
		"context_before": strings.Join(before, "\n"),
		"context_after":  strings.Join(after, "\n"),
	}
	if ctx != nil && ctx.FilePath != "" {
		state["file"] = ctx.FilePath
	}
	if ctx != nil && (ctx.OursIntent != "" || ctx.TheirsIntent != "") {
		oi := ctx.OursIntent
		if oi == "" {
			oi = hunk.OursLabel
		}
		ti := ctx.TheirsIntent
		if ti == "" {
			ti = hunk.TheirsLabel
		}
		state["intent"] = map[string]any{"ours": oi, "theirs": ti}
	}
	return state
}

// BuildHunkRequest: one Choice over candidates + a coverage Noul + one
// verification Noul per candidate, in a single request.
func BuildHunkRequest(parsed *ParsedConflicts, hunk *ConflictHunk,
	candidates []Candidate, ctx *ResolveOptions) *SystemOneRequest {

	criteria := map[string]any{}
	for _, c := range candidates {
		criteria[string(c.Kind)] = c.Description
	}
	criteria[NOVEL] = novelDescription

	questions := map[string]Question{
		PICK: Choice(
			"Which candidate is the correct resolution for this conflict? Judge by what each side's change was for: the right answer may keep one side, keep both, or restore the base — and it does not keep work that is moot, duplicated, or already subsumed by the other side.",
			criteria),
		COVERED: Noul(
			"Is the correct resolution of this conflict fully contained in one of the listed candidates — meaning no new code, edits, or synthesis beyond them is required?"),
	}

	if ctx == nil || !ctx.NoVerify {
		for _, c := range candidates {
			questions[VerifyKey(c.Kind)] = Noul(map[string]any{
				"instruction": fmt.Sprintf(
					"If candidate %q were applied — %s — would the result preserve the intent of BOTH the OURS and THEIRS changes (or correctly discard work that is genuinely moot)?",
					c.Kind, c.Description),
				"candidate_result": block("candidate "+string(c.Kind), truncateLines(c.Lines, 60)),
			})
		}
	}

	req := &SystemOneRequest{State: BuildState(parsed, hunk, ctx), Questions: questions}
	if ctx != nil {
		req.Model = ctx.Model
	}
	return req
}

// BuildDiscardCheckRequest: show Jev the actual lines a pick drops and ask
// whether losing them is safe — a sharper elicitation than judging the
// kept candidate.
func BuildDiscardCheckRequest(parsed *ParsedConflicts, hunk *ConflictHunk,
	droppedLines []string, pickedKind CandidateKind, ctx *ResolveOptions) *SystemOneRequest {

	req := &SystemOneRequest{
		State: BuildState(parsed, hunk, ctx),
		Questions: map[string]Question{
			DISCARD_CHECK: Noul(map[string]any{
				"instruction": fmt.Sprintf(
					"The resolution picked %q, which discards the lines below from the other side. Is losing them safe — are they genuinely moot, duplicated, or already subsumed by what is kept, meaning no real functionality, fields, dependencies, handling, or tests are lost?",
					pickedKind),
				"dropped_lines": block("lines dropped by the pick", truncateLines(droppedLines, 60)),
			}),
		},
	}
	if ctx != nil {
		req.Model = ctx.Model
	}
	return req
}

type LineSide struct {
	Line string
	Side string // "ours" | "theirs"
}

// BuildPerLineRequest: one keep/drop noul per non-shared union line —
// the last-resort composition ask.
func BuildPerLineRequest(parsed *ParsedConflicts, hunk *ConflictHunk,
	lines []LineSide, ctx *ResolveOptions) *SystemOneRequest {

	questions := map[string]Question{}
	for i, l := range lines {
		questions[fmt.Sprintf("keep_%d", i)] = Noul(map[string]any{
			"instruction": fmt.Sprintf(
				"Should this exact line from %s appear in the correct resolution of the conflict? Yes if the resolved file should contain it, no if the resolution drops it.",
				strings.ToUpper(l.Side)),
			"line": l.Line,
		})
	}
	req := &SystemOneRequest{State: BuildState(parsed, hunk, ctx), Questions: questions}
	if ctx != nil {
		req.Model = ctx.Model
	}
	return req
}

// BuildSpliceVerifyRequest: one noul over the composed result against the
// original whole hunk's context — window verifies judge parts, this judges
// the composition.
func BuildSpliceVerifyRequest(parsed *ParsedConflicts, hunk *ConflictHunk,
	splicedLines []string, ctx *ResolveOptions) *SystemOneRequest {

	req := &SystemOneRequest{
		State: BuildState(parsed, hunk, ctx),
		Questions: map[string]Question{
			VERIFY_SPLICED: Noul(map[string]any{
				"instruction":      "If this merged result were applied, would it preserve the intent of BOTH the OURS and THEIRS changes (or correctly discard work that is genuinely moot)?",
				"candidate_result": block("spliced resolution", truncateLines(splicedLines, 60)),
			}),
		},
	}
	if ctx != nil {
		req.Model = ctx.Model
	}
	return req
}
