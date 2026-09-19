package core

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// EscalateAll flips applied outcomes at index >= startIdx to escalated —
// used by callers vetoing whole-file results.
func EscalateAll(outcomes []HunkOutcome, reason EscalationReason, startIdx int) []HunkOutcome {
	out := append([]HunkOutcome{}, outcomes...)
	for i := range out {
		if i >= startIdx && out[i].Decision.Action == "apply" {
			out[i].Decision = Decision{
				Action: "escalate",
				Reason: reason,
				Detail: DecisionDetail{Verify: map[string]float64{}},
			}
		}
	}
	return out
}

const situationSuffix = " The marked region is one window of a larger conflict — neighboring" +
	" windows are decided separately, so resolve THIS region only. Lines" +
	" outside the markers are context shared by both versions."

// weaveOrder permutes keep/drop items into emission order: each item's key
// is the base position its line replaces (see BaseAnchors), so kept lines
// interleave the way the merge actually reads instead of all-ours-then-
// all-theirs. Without base the caller falls back to block order.
func weaveOrder(items []LineSideIdx, w *Element) []int {
	oA := BaseAnchors(w.Base, w.Ours)
	tA := BaseAnchors(w.Base, w.Theirs)
	type keyed struct {
		i   int
		key float64
	}
	ks := make([]keyed, len(items))
	for i, it := range items {
		if it.Side == "ours" {
			ks[i] = keyed{i, oA[it.Idx]}
		} else {
			ks[i] = keyed{i, tA[it.Idx]}
		}
	}
	sort.SliceStable(ks, func(a, b int) bool {
		if ks[a].key != ks[b].key {
			return ks[a].key < ks[b].key
		}
		return ks[a].i < ks[b].i
	})
	out := make([]int, len(ks))
	for i, k := range ks {
		out[i] = k.i
	}
	return out
}

// LineSideIdx is a union line plus which side's slice it came from.
type LineSideIdx struct {
	Line string
	Side string // "ours" | "theirs"
	Idx  int
}

func addUsage(a, b *Usage) *Usage {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	return &Usage{
		InputTokens:  a.InputTokens + b.InputTokens,
		OutputTokens: a.OutputTokens + b.OutputTokens,
	}
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

func derefOr(p *float64, d float64) float64 {
	if p == nil {
		return d
	}
	return *p
}

// windowContext: resolved-so-far (anchors + applied windows) before the
// window, upcoming anchors after it, plus real file context outside the
// conflict.
func windowContext(parsed *ParsedConflicts, hunk *ConflictHunk,
	elements []Element, index int, resolvedSoFar []string) (before, after []string) {

	lo := hunk.StartLine - 5
	if lo < 0 {
		lo = 0
	}
	fileBefore := parsed.Lines[lo:hunk.StartLine]
	hi := hunk.EndLine + 5
	if hi > len(parsed.Lines) {
		hi = len(parsed.Lines)
	}
	fileAfter := parsed.Lines[hunk.EndLine:hi]

	before = append(append([]string{}, fileBefore...), resolvedSoFar...)
	if len(before) > 15 {
		before = before[len(before)-15:]
	}
	var afterAnchors []string
	for i := index + 1; i < len(elements) && len(afterAnchors) < 15; i++ {
		if elements[i].Kind == "anchor" {
			afterAnchors = append(afterAnchors, elements[i].Lines...)
		}
	}
	after = append(append([]string{}, afterAnchors...), fileAfter...)
	if len(after) > 15 {
		after = after[:15]
	}
	return before, after
}

// decomposeAdaptive tries finest granularity first; coarsens only when the
// window count would blow the ask budget. nil when no granularity produces
// a useful split.
func decomposeAdaptive(hunk *ConflictHunk, maxWindows int) []Element {
	for _, minAnchor := range []int{1, 3, 8} {
		d := DecomposeHunk(hunk, minAnchor)
		if d.Windows == 0 || d.Windows > maxWindows {
			continue
		}
		var ws []Element
		for _, e := range d.Elements {
			if e.Kind == "window" {
				ws = append(ws, e)
			}
		}
		// A single window spanning the whole hunk is the same question again.
		if len(ws) == 1 && len(ws[0].Ours) == len(hunk.Ours) && len(ws[0].Theirs) == len(hunk.Theirs) {
			continue
		}
		return d.Elements
	}
	return nil
}

type windowResult struct {
	decision Decision
	usage    *Usage
}

// resolveHunkDecomposed: align ours/theirs(/base) into anchors + windows,
// ask Jev per window, splice winners. nil result when the hunk can't
// usefully decompose, so the caller keeps the original verdict. A non-nil
// error means an ask failed mid-pipeline — like the TS bare awaits, it
// propagates so the hunk escalates ask-failed.
func resolveHunkDecomposed(ctx context.Context, parsed *ParsedConflicts,
	hunk *ConflictHunk, ask Asker, opts *ResolveOptions,
	wholeHunkReason EscalationReason) (*windowResult, error) {

	elements := decomposeAdaptive(hunk, opts.maxWindows())
	if elements == nil {
		return nil, nil
	}

	var windowTraces []WindowTrace
	var resolvedSoFar []string
	winners := map[int][]string{}
	var usage *Usage
	wi := 0

	for i := 0; i < len(elements); i++ {
		e := &elements[i]
		if e.Kind == "anchor" {
			resolvedSoFar = append(resolvedSoFar, e.Lines...)
			continue
		}
		synthHunk := &ConflictHunk{
			StartLine:   hunk.StartLine,
			EndLine:     hunk.EndLine,
			OursLabel:   hunk.OursLabel,
			TheirsLabel: hunk.TheirsLabel,
			Ours:        e.Ours,
			Theirs:      e.Theirs,
			Base:        e.Base,
		}
		candidates := EnumerateCandidates(synthHunk, opts.FilePath)
		ctxBefore, ctxAfter := windowContext(parsed, hunk, elements, i, resolvedSoFar)
		wopts := *opts
		wopts.ContextBefore = ctxBefore
		wopts.ContextAfter = ctxAfter
		wopts.SituationSuffix = situationSuffix

		request := BuildHunkRequest(parsed, synthHunk, candidates, &wopts)

		result, err := ask(ctx, request)
		if err != nil {
			windowTraces = append(windowTraces, WindowTrace{
				Index: wi, OursLines: len(e.Ours), TheirsLines: len(e.Theirs),
				Action: "escalate", Reason: ReasonAskFailed,
			})
			return &windowResult{decision: Decision{
				Action: "escalate", Reason: ReasonAskFailed,
				Detail: DecisionDetail{
					Verify: map[string]float64{}, Error: err.Error(),
					Windows: windowTraces, WholeHunkReason: wholeHunkReason,
				},
			}, usage: usage}, nil
		}
		usage = addUsage(usage, &result.Usage)
		d := Interpret(result, candidates, &wopts)

		// Second opinion at window granularity: a consistent re-pick that
		// clears the gates rescues a borderline window escalation.
		if d.Action == "escalate" && d.Reason != ReasonAskFailed && opts.secondOpinion() {
			r2, err := ask(ctx, request)
			if err != nil {
				return nil, err
			}
			usage = addUsage(usage, &r2.Usage)
			d2 := Interpret(r2, candidates, &wopts)
			if d2.Action == "apply" && d2.Candidate != nil &&
				string(d2.Candidate.Kind) == d.Detail.Picked {
				d = d2
			}
		}

		// Per-line rescue at window granularity: the union is small, so
		// keep/drop per line is cheap — and a composed subset can be the
		// right window answer when no flat candidate is. A failed window
		// kills the whole splice; this is the last shot before it does.
		windowPerLine := false
		if d.Action == "escalate" && d.Reason != ReasonAskFailed && opts.perLine() {
			seen := map[string]bool{}
			for _, l := range e.Ours {
				seen[trimKey(l)] = true
			}
			var askItems []LineSideIdx
			for idx, l := range e.Ours {
				askItems = append(askItems, LineSideIdx{l, "ours", idx})
			}
			for idx, l := range e.Theirs {
				if !seen[trimKey(l)] {
					askItems = append(askItems, LineSideIdx{l, "theirs", idx})
				}
			}
			askLines := make([]LineSide, len(askItems))
			for i2, it := range askItems {
				askLines[i2] = LineSide{it.Line, it.Side}
			}
			var order []int
			if e.Base != nil {
				order = weaveOrder(askItems, e)
			} else {
				order = make([]int, len(askLines))
				for i2 := range order {
					order[i2] = i2
				}
			}
			if len(askLines) > 0 {
				r3, err := ask(ctx, BuildPerLineRequest(parsed, synthHunk, askLines, &wopts))
				if err != nil {
					return nil, err
				}
				usage = addUsage(usage, &r3.Usage)
				nouls := make([]float64, len(askLines))
				def := make([]bool, len(askLines))
				for i2 := range askLines {
					if a, ok := r3.Answers[fmt.Sprintf("keep_%d", i2)]; ok && a.IsNoul() {
						nouls[i2], def[i2] = a.Noul, true
					}
				}
				var kept []string
				for _, i2 := range order {
					if def[i2] && nouls[i2] >= 0.5 {
						kept = append(kept, askLines[i2].Line)
					}
				}
				// A composition built of confident line decisions is a real
				// answer; one built of ~0.5 coin-flips is noise — gate on
				// decisiveness.
				var margins []float64
				for i2 := range nouls {
					if def[i2] {
						margins = append(margins, abs(nouls[i2]-0.5))
					}
				}
				meanMargin := 0.0
				for _, m := range margins {
					meanMargin += m
				}
				if len(margins) > 0 {
					meanMargin /= float64(len(margins))
				}
				// Only a genuine subset earns the apply — when keep/drop
				// re-derives an existing flat candidate it adds no
				// information, and the flat ask already declined it.
				isSubset := len(kept) > 0 && meanMargin >= 0.2
				if isSubset {
					key := strings.Join(kept, "\n")
					for _, c := range candidates {
						if strings.Join(c.Lines, "\n") == key {
							isSubset = false
							break
						}
					}
				}
				if isSubset {
					d = Decision{
						Action: "apply",
						Candidate: &Candidate{
							Kind:        Spliced,
							Description: "Line-level merge: composed by per-line keep/drop over the window union.",
							Lines:       kept,
						},
						Detail: DecisionDetail{Verify: map[string]float64{}, PerLine: true},
					}
					windowPerLine = true
				}
			}
		}

		trace := WindowTrace{
			Index: wi, OursLines: len(e.Ours), TheirsLines: len(e.Theirs),
			Picked: d.Detail.Picked, Confidence: d.Detail.Confidence,
			Coverage: d.Detail.Coverage, Action: d.Action, PerLine: windowPerLine,
		}
		if d.Action == "escalate" {
			trace.Reason = d.Reason
		}
		windowTraces = append(windowTraces, trace)
		if d.Action == "escalate" {
			detail := d.Detail
			detail.Windows = windowTraces
			detail.WholeHunkReason = wholeHunkReason
			return &windowResult{decision: Decision{
				Action: "escalate", Reason: d.Reason, Detail: detail,
			}, usage: usage}, nil
		}
		winners[wi] = d.Candidate.Lines
		resolvedSoFar = append(resolvedSoFar, d.Candidate.Lines...)
		wi++
	}

	// Splice anchors + winners into the full replacement text.
	var lines []string
	wi = 0
	for _, e := range elements {
		if e.Kind == "anchor" {
			lines = append(lines, e.Lines...)
		} else {
			lines = append(lines, winners[wi]...)
			wi++
		}
	}

	// Verify the composition as a whole — window-level verifies judge
	// parts; a splice can be locally consistent and globally wrong.
	var spliceScore *float64
	if !opts.NoVerify {
		vr, err := ask(ctx, BuildSpliceVerifyRequest(parsed, hunk, lines, opts))
		if err != nil {
			return nil, err
		}
		usage = addUsage(usage, &vr.Usage)
		if a, ok := vr.Answers[VERIFY_SPLICED]; ok && a.IsNoul() {
			spliceScore = f64(a.Noul)
		}
		if spliceScore != nil && *spliceScore < 0.3 {
			return &windowResult{decision: Decision{
				Action: "escalate", Reason: ReasonVerification,
				Detail: DecisionDetail{
					Verify:  map[string]float64{"spliced": *spliceScore},
					Windows: windowTraces, WholeHunkReason: wholeHunkReason,
				},
			}, usage: usage}, nil
		}
	}

	verify := map[string]float64{}
	if spliceScore != nil {
		verify["spliced"] = *spliceScore
	}
	return &windowResult{decision: Decision{
		Action: "apply",
		Candidate: &Candidate{
			Kind:        Spliced,
			Description: "Line-level merge: the conflict was split into sub-regions and each resolved separately.",
			Lines:       lines,
		},
		Detail: DecisionDetail{
			Verify: verify, Windows: windowTraces, WholeHunkReason: wholeHunkReason,
		},
	}, usage: usage}, nil
}

// askFailedOutcome is the outcome shape the TS outer catch produces when
// any ask in the retry ladder throws.
func askFailedOutcome(i int, hunk *ConflictHunk, err error) HunkOutcome {
	return HunkOutcome{
		HunkIndex: i, Hunk: *hunk,
		Decision: Decision{
			Action: "escalate", Reason: ReasonAskFailed,
			Detail: DecisionDetail{Verify: map[string]float64{}, Error: err.Error()},
		},
	}
}

// ResolveText resolves every conflict hunk in text: enumerate candidates,
// ask Jev once per hunk (fanned-out questions), apply winners, leave
// markers on escalations so a human/LLM still sees them. Escalated hunks
// retry as decomposed sub-conflicts unless opts.Decompose is false.
func ResolveText(ctx context.Context, text string, ask Asker, opts *ResolveOptions) (*ResolveResult, error) {
	if opts == nil {
		opts = &ResolveOptions{}
	}
	parsed, err := ParseConflicts(text)
	if err != nil {
		return nil, err
	}
	var outcomes []HunkOutcome

	for i := range parsed.Hunks {
		hunk := &parsed.Hunks[i]
		candidates := EnumerateCandidates(hunk, opts.FilePath)
		request := BuildHunkRequest(parsed, hunk, candidates, opts)

		result, err := ask(ctx, request)
		if err != nil {
			outcomes = append(outcomes, askFailedOutcome(i, hunk, err))
			continue
		}
		decision := Interpret(result, candidates, opts)
		var usage *Usage = &result.Usage
		fatal := false

		// Second opinion: re-sample an escalated hunk once before
		// decomposing. Apply only if the resample picks the SAME candidate
		// and now clears the gates — pick-agreement across samples is real
		// consistency, not noise.
		if decision.Action == "escalate" && decision.Reason != ReasonAskFailed && opts.secondOpinion() {
			r2, err := ask(ctx, request)
			if err != nil {
				fatal = true
			} else {
				usage = addUsage(usage, &r2.Usage)
				d2 := Interpret(r2, candidates, opts)
				if d2.Action == "apply" && d2.Candidate != nil &&
					string(d2.Candidate.Kind) == decision.Detail.Picked {
					d2.Detail.SecondOpinion = true
					decision = d2
				}
			}
		}

		wholeHunkProbs := decision.Detail.Probabilities
		wholeHunkPicked := decision.Detail.Picked

		if !fatal && opts.decompose() {
			covFail := decision.Action == "apply" &&
				decision.Detail.Coverage != nil &&
				*decision.Detail.Coverage < opts.minCoverage()
			// Escalations retry per-window; applies with hedged coverage
			// get refined per-window too — a spliced verdict is strictly
			// better information than a single-side pick the model doubts
			// covers it.
			if (decision.Action == "escalate" && decision.Reason != ReasonAskFailed) || covFail {
				reason := decision.Reason
				if decision.Action != "escalate" {
					reason = ReasonNotInCandidates
				}
				retry, derr := resolveHunkDecomposed(ctx, parsed, hunk, ask, opts, reason)
				if derr != nil {
					fatal = true
				} else if retry != nil {
					decision = retry.decision
					usage = addUsage(usage, retry.usage)
				}
			}
		}

		// Head-to-head: a binary pick between the top-2 whole-hunk
		// candidates is a different elicitation than the N-way pick —
		// sharper on borderline hunks that survived every other retry.
		if !fatal && decision.Action == "escalate" && decision.Reason != ReasonAskFailed &&
			opts.headToHead() && wholeHunkProbs != nil {
			type kv struct {
				k string
				v float64
			}
			var sorted []kv
			for k, v := range wholeHunkProbs {
				if k != NOVEL {
					sorted = append(sorted, kv{k, v})
				}
			}
			sort.SliceStable(sorted, func(a, b int) bool { return sorted[a].v > sorted[b].v })
			var top2 []Candidate
			for _, e := range sorted {
				for _, c := range candidates {
					if string(c.Kind) == e.k {
						top2 = append(top2, c)
						break
					}
				}
				if len(top2) == 2 {
					break
				}
			}
			if len(top2) == 2 {
				r3, err := ask(ctx, BuildHunkRequest(parsed, hunk, top2, opts))
				if err != nil {
					fatal = true
				} else {
					usage = addUsage(usage, &r3.Usage)
					d3 := Interpret(r3, top2, opts)
					// Apply only on confirmation: the binary pick must
					// re-select the original top candidate — a flip to the
					// runner-up is exactly the instability the gates were
					// sensing.
					if d3.Action == "apply" && d3.Candidate != nil &&
						string(d3.Candidate.Kind) == wholeHunkPicked {
						d3.Detail.HeadToHead = true
						decision = d3
					}
				}
			}
		}

		// Discard audit: a borderline pick that drops the other side's work
		// must survive a focused check on the actual lines being lost.
		// Single-side picks that silently kill real work are the dominant
		// wrong-apply shape — asymmetric gates for the dangerous direction.
		if !fatal && decision.Action == "apply" && DISCARDING[decision.Candidate.Kind] &&
			derefOr(decision.Detail.Confidence, 0) < 0.6 && !opts.NoVerify {
			oursSet, theirsSet := map[string]bool{}, map[string]bool{}
			for _, l := range hunk.Ours {
				oursSet[trimKey(l)] = true
			}
			for _, l := range hunk.Theirs {
				theirsSet[trimKey(l)] = true
			}
			kind := decision.Candidate.Kind
			var dropped []string
			switch kind {
			case Ours:
				for _, l := range hunk.Theirs {
					if !oursSet[trimKey(l)] {
						dropped = append(dropped, l)
					}
				}
			case Theirs:
				for _, l := range hunk.Ours {
					if !theirsSet[trimKey(l)] {
						dropped = append(dropped, l)
					}
				}
			default:
				for _, l := range hunk.Ours {
					if !theirsSet[trimKey(l)] {
						dropped = append(dropped, l)
					}
				}
				for _, l := range hunk.Theirs {
					if !oursSet[trimKey(l)] {
						dropped = append(dropped, l)
					}
				}
			}
			if len(dropped) > 0 {
				dr, err := ask(ctx, BuildDiscardCheckRequest(parsed, hunk, dropped, kind, opts))
				if err != nil {
					fatal = true
				} else {
					usage = addUsage(usage, &dr.Usage)
					if a, ok := dr.Answers[DISCARD_CHECK]; ok && a.IsNoul() && a.Noul < 0.5 {
						detail := decision.Detail
						detail.Discard = map[string]float64{"check": a.Noul}
						decision = Decision{
							Action: "escalate", Reason: ReasonDiscardsWork, Detail: detail,
						}
					}
				}
			}
		}

		// Per-line composition: last resort when no enumerated candidate
		// can express the resolution. Keep/drop per non-shared union line
		// (anchors are kept — they are in both versions), then the composed
		// subset is verified like a splice.
		if !fatal && decision.Action == "escalate" && decision.Reason != ReasonAskFailed && opts.perLine() {
			d := DecomposeHunk(hunk, 1)
			var asked []LineSide
			type slot struct {
				anchor []string
				idxs   []int
			}
			var slots []slot
			for ei := range d.Elements {
				e := &d.Elements[ei]
				if e.Kind == "anchor" {
					slots = append(slots, slot{anchor: e.Lines})
					continue
				}
				var idxs []int
				seen := map[string]bool{}
				for _, l := range e.Ours {
					seen[l] = true
				}
				var local []LineSideIdx
				for idx, l := range e.Ours {
					local = append(local, LineSideIdx{l, "ours", idx})
				}
				for idx, l := range e.Theirs {
					if !seen[l] {
						local = append(local, LineSideIdx{l, "theirs", idx})
					}
				}
				var order []int
				if e.Base != nil {
					order = weaveOrder(local, e)
				} else {
					order = make([]int, len(local))
					for i2 := range order {
						order[i2] = i2
					}
				}
				for _, li := range order {
					idxs = append(idxs, len(asked))
					asked = append(asked, LineSide{local[li].Line, local[li].Side})
				}
				slots = append(slots, slot{idxs: idxs})
			}
			if len(asked) > 0 && len(asked) <= 40 {
				r4, err := ask(ctx, BuildPerLineRequest(parsed, hunk, asked, opts))
				if err != nil {
					fatal = true
				} else {
					usage = addUsage(usage, &r4.Usage)
					nouls := make([]float64, len(asked))
					def := make([]bool, len(asked))
					for i2 := range asked {
						if a, ok := r4.Answers[fmt.Sprintf("keep_%d", i2)]; ok && a.IsNoul() {
							nouls[i2], def[i2] = a.Noul, true
						}
					}
					keep := make([]bool, len(asked))
					for i2 := range nouls {
						keep[i2] = def[i2] && nouls[i2] >= 0.5
					}
					var lines []string
					for _, s := range slots {
						if s.anchor != nil {
							lines = append(lines, s.anchor...)
						} else {
							for _, i2 := range s.idxs {
								if keep[i2] {
									lines = append(lines, asked[i2].Line)
								}
							}
						}
					}
					// Decisiveness gate: a composition of confident line
					// decisions is a real answer; one of ~0.5 coin-flips is
					// noise.
					var margins []float64
					for i2 := range nouls {
						if def[i2] {
							margins = append(margins, abs(nouls[i2]-0.5))
						}
					}
					meanMargin := 0.0
					for _, m := range margins {
						meanMargin += m
					}
					if len(margins) > 0 {
						meanMargin /= float64(len(margins))
					}
					// Only apply a composition that differs from every flat
					// candidate — re-deriving a pick the gates already
					// rejected (or the discard audit just vetoed) adds no
					// information.
					novel := len(lines) > 0 && meanMargin >= 0.2
					if novel {
						key := strings.Join(lines, "\n")
						for _, c := range candidates {
							if strings.Join(c.Lines, "\n") == key {
								novel = false
								break
							}
						}
					}
					if novel {
						var spliceScore *float64
						if !opts.NoVerify {
							vr, err := ask(ctx, BuildSpliceVerifyRequest(parsed, hunk, lines, opts))
							if err != nil {
								fatal = true
							} else {
								usage = addUsage(usage, &vr.Usage)
								if a, ok := vr.Answers[VERIFY_SPLICED]; ok && a.IsNoul() {
									spliceScore = f64(a.Noul)
								}
							}
						}
						// Same strong-fail gate as window splices — 0.5 was
						// measured to kill good compositions along with bad
						// (it does not discriminate for composed candidates).
						if !fatal && (spliceScore == nil || *spliceScore >= 0.3) {
							verify := map[string]float64{}
							if spliceScore != nil {
								verify["spliced"] = *spliceScore
							}
							decision = Decision{
								Action: "apply",
								Candidate: &Candidate{
									Kind:        Spliced,
									Description: "Line-level merge: composed by per-line keep/drop over the union.",
									Lines:       lines,
								},
								Detail: DecisionDetail{
									Verify: verify, PerLine: true,
									WholeHunkReason: decision.Reason,
								},
							}
						}
					}
				}
			}
		}

		if fatal {
			outcomes = append(outcomes, askFailedOutcome(i, hunk, errAskLadder))
			continue
		}
		outcomes = append(outcomes, HunkOutcome{
			HunkIndex: i, Hunk: *hunk, Decision: decision, Usage: usage,
		})
	}

	// Splice winners bottom-up so earlier indices stay valid.
	splice := func() []string {
		out := append([]string{}, parsed.Lines...)
		for i := len(outcomes) - 1; i >= 0; i-- {
			o := outcomes[i]
			if o.Decision.Action != "apply" {
				continue
			}
			head := append([]string{}, out[:o.Hunk.StartLine]...)
			tail := append([]string{}, out[o.Hunk.EndLine:]...)
			out = append(append(head, o.Decision.Candidate.Lines...), tail...)
		}
		return out
	}
	lines := splice()

	// Composed-file sanity: hunks decide independently, so the full file
	// can still be globally broken — unparseable JSON, or a block emitted
	// twice by different hunks. Veto the offending applies (all of them
	// when the break can't be attributed) so the markers stay for a human.
	veto := map[int]bool{}
	if strings.HasSuffix(opts.FilePath, ".json") && len(outcomes) > 0 {
		allApplied := true
		for _, o := range outcomes {
			if o.Decision.Action != "apply" {
				allApplied = false
				break
			}
		}
		if allApplied {
			// Only meaningful for strict JSON — a file whose own context
			// already has // comments or comma-before-bracket is JSONC
			// (tsconfig-style), where neither repair nor a parse veto
			// applies.
			inHunk := map[int]bool{}
			for _, h := range parsed.Hunks {
				for j := h.StartLine; j < h.EndLine; j++ {
					inHunk[j] = true
				}
			}
			ctxLines := make([]string, len(parsed.Lines))
			for j, l := range parsed.Lines {
				if !inHunk[j] {
					ctxLines[j] = l
				}
			}
			jsoncish := false
			for j := 0; j < len(ctxLines) && !jsoncish; j++ {
				t := strings.TrimSpace(ctxLines[j])
				if strings.HasPrefix(t, "//") || strings.HasPrefix(t, "/*") {
					jsoncish = true
					break
				}
				if !strings.HasSuffix(t, ",") {
					continue
				}
				for k := j + 1; k < len(ctxLines); k++ {
					u := strings.TrimSpace(ctxLines[k])
					if u == "" {
						// A blanked hunk line means the comma's real
						// successor is hunk content — not a context
						// pattern, so don't flag it.
						if inHunk[k] {
							break
						}
						continue
					}
					if closeBracketRe.MatchString(u) {
						jsoncish = true
					}
					break
				}
			}
			if !jsoncish {
				// Strict JSON can't contain `,\n}` anywhere, so repair can
				// only move the output toward a valid resolution.
				lines = RepairTrailingCommas(lines)
				var v any
				if json.Unmarshal([]byte(strings.Join(lines, "\n")), &v) != nil {
					for j, o := range outcomes {
						if o.Decision.Action == "apply" {
							veto[j] = true
						}
					}
				}
			}
		}
	}

	// Duplicated-block detection, keyed by what the hunk's own source
	// already contained: a >=5-line window emitted by two hunks (or twice
	// within one candidate) is only suspect when the emitting hunk's
	// source lacked it — that's the resolver synthesizing a duplicate,
	// not carrying through a block the file legitimately repeats.
	srcWindows := make([]map[string]bool, len(parsed.Hunks))
	for hi, h := range parsed.Hunks {
		s := map[string]bool{}
		for _, side := range [][]string{h.Ours, h.Theirs, h.Base} {
			var ls []string
			for _, l := range side {
				if t := strings.TrimSpace(l); t != "" {
					ls = append(ls, t)
				}
			}
			for j := 0; j+5 <= len(ls); j++ {
				w := strings.Join(ls[j:j+5], "\n")
				if len(w) >= 20 {
					s[w] = true
				}
			}
		}
		srcWindows[hi] = s
	}
	windowOwners := map[string]map[int]bool{}
	for oi, o := range outcomes {
		if o.Decision.Action != "apply" {
			continue
		}
		var ls []string
		for _, l := range o.Decision.Candidate.Lines {
			if t := strings.TrimSpace(l); t != "" {
				ls = append(ls, t)
			}
		}
		seenLocal := map[string]bool{}
		for j := 0; j+5 <= len(ls); j++ {
			w := strings.Join(ls[j:j+5], "\n")
			if len(w) < 20 {
				continue
			}
			if seenLocal[w] && !srcWindows[o.HunkIndex][w] {
				veto[oi] = true
			}
			seenLocal[w] = true
			if windowOwners[w] == nil {
				windowOwners[w] = map[int]bool{}
			}
			windowOwners[w][oi] = true
		}
	}
	for w, owners := range windowOwners {
		if len(owners) < 2 {
			continue
		}
		for i2 := range owners {
			if !srcWindows[outcomes[i2].HunkIndex][w] {
				veto[i2] = true
			}
		}
	}
	if len(veto) > 0 {
		for i2 := range veto {
			outcomes[i2].Decision = Decision{
				Action: "escalate", Reason: ReasonInvalidComposition,
				Detail: outcomes[i2].Decision.Detail,
			}
		}
		lines = splice()
	}

	res := &ResolveResult{Text: strings.Join(lines, "\n"), Outcomes: outcomes}
	for _, o := range outcomes {
		if o.Decision.Action == "apply" {
			res.Applied++
		} else {
			res.Escalated++
		}
	}
	return res, nil
}

var errAskLadder = fmt.Errorf("ask failed during retry ladder")
