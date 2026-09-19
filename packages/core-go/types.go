// Package core is a Go port of @fafo/core: a selector-not-generator
// merge-conflict adjudicator. Jev picks from candidates the code
// enumerates; low confidence, weak coverage, or failed verification
// escalates the hunk (markers stay in the file).
package core

import "context"

// ConflictHunk is one <<<<<<< … ======= … >>>>>>> block in a file.
type ConflictHunk struct {
	// Index into ParsedConflicts.Lines of the `<<<<<<<` marker.
	StartLine int
	// Index into ParsedConflicts.Lines one past the `>>>>>>>` marker.
	EndLine     int
	OursLabel   string   // label after `<<<<<<<` (e.g. "HEAD")
	TheirsLabel string   // label after `>>>>>>>`
	Ours        []string // lines between `<<<<<<<` and `=======` (or `|||||||`)
	Base        []string // lines between `|||||||` and `=======`; nil for two-way
	Theirs      []string // lines between `=======` and `>>>>>>>`
}

type ParsedConflicts struct {
	Lines []string
	Hunks []ConflictHunk
}

type CandidateKind string

const (
	Ours           CandidateKind = "ours"
	Theirs         CandidateKind = "theirs"
	BothOursTheirs CandidateKind = "both-ours-theirs"
	BothTheirsOurs CandidateKind = "both-theirs-ours"
	Union          CandidateKind = "union"
	Base           CandidateKind = "base"
	Drop           CandidateKind = "drop"
	Spliced        CandidateKind = "spliced"
)

type Candidate struct {
	Kind        CandidateKind
	Description string   // what this candidate means, phrased for the model
	Lines       []string // replacement lines (empty for drop)
}

// HunkContext carries optional caller-supplied context about each side.
type HunkContext struct {
	FilePath        string
	OursIntent      string // free-text description of our side (e.g. commit msg)
	TheirsIntent    string
	ContextLines    int      // surrounding lines in state; default 15
	ContextBefore   []string // override for state.context_before
	ContextAfter    []string // override for state.context_after
	SituationSuffix string   // appended to the state situation line
}

type EscalationReason string

const (
	ReasonNotInCandidates    EscalationReason = "not-in-candidates"
	ReasonNovelMerge         EscalationReason = "novel-merge-needed"
	ReasonVerification       EscalationReason = "verification-failed"
	ReasonDiscardsWork       EscalationReason = "discards-work"
	ReasonLowConfidence      EscalationReason = "low-confidence"
	ReasonInvalidComposition EscalationReason = "invalid-composition"
	ReasonAskFailed          EscalationReason = "ask-failed"
)

// WindowTrace records one window's verdict inside a decomposed decision.
type WindowTrace struct {
	Index       int              `json:"index"`
	OursLines   int              `json:"oursLines"`
	TheirsLines int              `json:"theirsLines"`
	Picked      string           `json:"picked,omitempty"`
	Confidence  *float64         `json:"confidence,omitempty"`
	Coverage    *float64         `json:"coverage,omitempty"`
	Action      string           `json:"action"` // "apply" | "escalate"
	Reason      EscalationReason `json:"reason,omitempty"`
	PerLine     bool             `json:"perLine,omitempty"`
}

type Decision struct {
	Action    string           `json:"action"` // "apply" | "escalate"
	Candidate *Candidate       `json:"candidate,omitempty"`
	Reason    EscalationReason `json:"reason,omitempty"`
	Detail    DecisionDetail   `json:"detail"`
}

// DecisionDetail keeps the raw signals for evaluation.
type DecisionDetail struct {
	Picked          string             `json:"picked,omitempty"`
	Confidence      *float64           `json:"confidence,omitempty"`
	PickMargin      *float64           `json:"pickMargin,omitempty"`
	Coverage        *float64           `json:"coverage,omitempty"`
	Verify          map[string]float64 `json:"verify"`
	Discard         map[string]float64 `json:"discard,omitempty"`
	Probabilities   map[string]float64 `json:"probabilities,omitempty"`
	Error           string             `json:"error,omitempty"`
	Windows         []WindowTrace      `json:"windows,omitempty"`
	WholeHunkReason EscalationReason   `json:"wholeHunkReason,omitempty"`
	SecondOpinion   bool               `json:"secondOpinion,omitempty"`
	HeadToHead      bool               `json:"headToHead,omitempty"`
	PerLine         bool               `json:"perLine,omitempty"`
}

type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

type HunkOutcome struct {
	HunkIndex int          `json:"hunk_index"`
	Hunk      ConflictHunk `json:"-"`
	Decision  Decision     `json:"decision"`
	Usage     *Usage       `json:"usage,omitempty"`
}

type ResolveResult struct {
	Text      string // applied candidates spliced; escalated keep markers
	Outcomes  []HunkOutcome
	Applied   int
	Escalated int
}

// ResolveOptions mirrors the TS version: nil means "use the default".
type ResolveOptions struct {
	HunkContext
	MinConfidence *float64 // default 0.5
	MinCoverage   *float64 // default 0.5
	MinVerify     *float64 // default 0.5
	NoVerify      bool     // skip per-candidate verification nouls
	Model         string   // model override
	Decompose     *bool    // default true — retry escalations per-window
	SecondOpinion *bool    // default true — one consistent re-sample
	MinPickMargin *float64 // default 0.1 — top-2 gap below which a pick is a hedge
	HeadToHead    *bool    // default true — binary top-2 pick after retries
	PerLine       *bool    // default true — last-resort per-line keep/drop
	MaxWindows    *int     // default 12
}

func f64(v float64) *float64 { return &v }
func b(v bool) *bool         { return &v }
func i(v int) *int           { return &v }

func (o *ResolveOptions) minConfidence() float64 {
	if o != nil && o.MinConfidence != nil {
		return *o.MinConfidence
	}
	return 0.5
}
func (o *ResolveOptions) minCoverage() float64 {
	if o != nil && o.MinCoverage != nil {
		return *o.MinCoverage
	}
	return 0.5
}
func (o *ResolveOptions) minVerify() float64 {
	if o != nil && o.MinVerify != nil {
		return *o.MinVerify
	}
	return 0.5
}
func (o *ResolveOptions) minPickMargin() float64 {
	if o != nil && o.MinPickMargin != nil {
		return *o.MinPickMargin
	}
	return 0.1
}
func (o *ResolveOptions) decompose() bool {
	return o == nil || o.Decompose == nil || *o.Decompose
}
func (o *ResolveOptions) secondOpinion() bool {
	return o == nil || o.SecondOpinion == nil || *o.SecondOpinion
}
func (o *ResolveOptions) headToHead() bool {
	return o == nil || o.HeadToHead == nil || *o.HeadToHead
}
func (o *ResolveOptions) perLine() bool {
	return o == nil || o.PerLine == nil || *o.PerLine
}
func (o *ResolveOptions) maxWindows() int {
	if o != nil && o.MaxWindows != nil {
		return *o.MaxWindows
	}
	return 12
}
func (o *ResolveOptions) contextLines() int {
	if o != nil && o.ContextLines > 0 {
		return o.ContextLines
	}
	return 15
}

// Asker is the one impure seam: everything else is pure. Implementations
// POST a SystemOneRequest and return the result (see HTTPAsker).
type Asker func(ctx context.Context, req *SystemOneRequest) (*SystemOneResult, error)
