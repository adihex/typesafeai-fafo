package core

import (
	"regexp"
	"strings"
)

var descriptions = map[CandidateKind]string{
	Ours:           "Take the OURS version only; discard the THEIRS change.",
	Theirs:         "Take the THEIRS version only; discard the OURS change.",
	BothOursTheirs: "Keep both changes: OURS lines first, then THEIRS lines.",
	BothTheirsOurs: "Keep both changes: THEIRS lines first, then OURS lines.",
	Union:          "Keep every distinct line from both versions, in OURS order then THEIRS-only lines appended.",
	Base:           "Restore the original BASE version; discard both changes.",
	Drop:           "Delete the conflicted region entirely; both versions are moot.",
	Spliced:        "Line-level merge: the conflict was split into sub-regions and each resolved separately.",
}

func dedupeLines(first, second []string) []string {
	seen := map[string]bool{}
	for _, l := range first {
		seen[l] = true
	}
	out := append([]string{}, first...)
	for _, l := range second {
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	return out
}

var closeBracketRe = regexp.MustCompile(`^[}\])]`)

// RepairTrailingCommas drops a trailing comma when the next non-blank line
// closes a bracket — verbatim concat can leave `,\n}` which is invalid in
// strict JSON. Only applied to .json files (trailing commas are legal in
// JS/TS, where repairing would diverge from a valid resolution).
func RepairTrailingCommas(lines []string) []string {
	out := append([]string{}, lines...)
	for i := range out {
		if !strings.HasSuffix(strings.TrimRight(out[i], " \t"), ",") {
			continue
		}
		var next string
		for j := i + 1; j < len(out); j++ {
			if strings.TrimSpace(out[j]) != "" {
				next = out[j]
				break
			}
		}
		if next != "" && closeBracketRe.MatchString(strings.TrimSpace(next)) {
			idx := strings.LastIndex(out[i], ",")
			out[i] = out[i][:idx] + out[i][idx+1:]
		}
	}
	return out
}

// EnumerateCandidates is the enumerable resolution space for one hunk.
// Candidates producing identical replacement text are dropped — same
// output, same resolution.
func EnumerateCandidates(hunk *ConflictHunk, filePath string) []Candidate {
	repair := func(ls []string) []string { return ls }
	if strings.HasSuffix(filePath, ".json") {
		repair = RepairTrailingCommas
	}
	all := []Candidate{
		{Kind: Ours, Description: descriptions[Ours], Lines: hunk.Ours},
		{Kind: Theirs, Description: descriptions[Theirs], Lines: hunk.Theirs},
		{Kind: BothOursTheirs, Description: descriptions[BothOursTheirs],
			Lines: repair(append(append([]string{}, hunk.Ours...), hunk.Theirs...))},
		{Kind: BothTheirsOurs, Description: descriptions[BothTheirsOurs],
			Lines: repair(append(append([]string{}, hunk.Theirs...), hunk.Ours...))},
		{Kind: Union, Description: descriptions[Union],
			Lines: repair(dedupeLines(hunk.Ours, hunk.Theirs))},
	}
	if hunk.Base != nil {
		all = append(all, Candidate{Kind: Base, Description: descriptions[Base], Lines: hunk.Base})
	}
	all = append(all, Candidate{Kind: Drop, Description: descriptions[Drop], Lines: []string{}})

	seen := map[string]bool{}
	var out []Candidate
	for _, c := range all {
		key := strings.Join(c.Lines, "\n")
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, c)
	}
	return out
}
