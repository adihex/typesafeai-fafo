package core

import "sort"

// STRONG_FLOOR: below this a signal is a "confident no", not a hedge.
const strongFloor = 0.3

// Interpret turns Jev's fanned-out answers into apply/escalate. Policy
// lives here, in code — the model supplies judgments, we decide what they
// permit.
//
// Coverage, winner verification and pick confidence all hedge around ~0.5
// on genuinely ambiguous conflicts, so each alone is a noisy veto.
// Escalate only when signals concur: a strong single failure (< 0.3) or
// two or more weak failures (< their thresholds). A lone borderline signal
// is treated as hedging. A needs-novel-merge pick always escalates, as
// does a failed ask.
func Interpret(result *SystemOneResult, candidates []Candidate, opts *ResolveOptions) Decision {
	minConfidence := opts.minConfidence()
	minCoverage := opts.minCoverage()
	minVerify := opts.minVerify()
	minMargin := opts.minPickMargin()

	answers := result.Answers
	pick, pickOK := answers[PICK]
	covered, coveredOK := answers[COVERED]

	verify := map[string]float64{}
	for _, c := range candidates {
		if a, ok := answers[VerifyKey(c.Kind)]; ok && a.IsNoul() {
			verify[string(c.Kind)] = a.Noul
		}
	}

	detail := DecisionDetail{Verify: verify}
	if coveredOK && covered.IsNoul() {
		detail.Coverage = f64(covered.Noul)
	}
	pickIsChoice := pickOK && pick.IsChoice()
	if pickIsChoice {
		detail.Picked = pick.Choice
		detail.Confidence = f64(pick.Confidence)
		detail.Probabilities = map[string]float64{}
		for k, v := range pick.Probabilities {
			detail.Probabilities[k] = v
		}
		vals := make([]float64, 0, len(detail.Probabilities))
		for _, v := range detail.Probabilities {
			vals = append(vals, v)
		}
		sort.Sort(sort.Reverse(sort.Float64Slice(vals)))
		if len(vals) >= 2 {
			detail.PickMargin = f64(vals[0] - vals[1])
		}
	}

	escalate := func(reason EscalationReason) Decision {
		return Decision{Action: "escalate", Reason: reason, Detail: detail}
	}

	if !pickIsChoice {
		return escalate(ReasonAskFailed)
	}
	if pick.Choice == NOVEL {
		return escalate(ReasonNovelMerge)
	}

	var winner *Candidate
	for i := range candidates {
		if string(candidates[i].Kind) == pick.Choice {
			winner = &candidates[i]
			break
		}
	}
	if winner == nil {
		return escalate(ReasonAskFailed)
	}

	conf := pick.Confidence
	margin := 1.0
	if detail.PickMargin != nil {
		margin = *detail.PickMargin
	}

	type fail struct {
		reason EscalationReason
		value  float64
	}
	var fails []fail
	var ver *float64
	if v, ok := verify[string(winner.Kind)]; ok {
		ver = &v
	}
	if detail.Coverage != nil && *detail.Coverage < minCoverage {
		fails = append(fails, fail{ReasonNotInCandidates, *detail.Coverage / minCoverage})
	}
	if ver != nil && *ver < minVerify {
		fails = append(fails, fail{ReasonVerification, *ver / minVerify})
	}
	if conf < minConfidence {
		fails = append(fails, fail{ReasonLowConfidence, conf / minConfidence})
	}
	if margin < minMargin {
		fails = append(fails, fail{ReasonLowConfidence, margin / minMargin})
	}

	strong := (detail.Coverage != nil && *detail.Coverage < strongFloor) ||
		(ver != nil && *ver < strongFloor) ||
		conf < strongFloor

	if strong || len(fails) >= 2 {
		sort.SliceStable(fails, func(i, j int) bool { return fails[i].value < fails[j].value })
		return escalate(fails[0].reason)
	}

	return Decision{Action: "apply", Candidate: winner, Detail: detail}
}
