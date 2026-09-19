package core

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

const CONFLICT_2WAY = `import a from "a";

<<<<<<< HEAD
const timeout = 5000;
=======
const timeout = 10000;
>>>>>>> feature

console.log(timeout);
`

const CONFLICT_DIFF3 = `x();
<<<<<<< HEAD
foo(1);
||||||| base
foo(0);
=======
foo(2);
>>>>>>> branch
y();
`

const MULTI = `a
<<<<<<< HEAD
o1
=======
t1
>>>>>>> b
mid
<<<<<<< HEAD
o2
=======
t2
>>>>>>> b
z
`

func mustParse(t *testing.T, text string) *ParsedConflicts {
	t.Helper()
	p, err := ParseConflicts(text)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return p
}

func eqStrings(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestParseTwoWay(t *testing.T) {
	p := mustParse(t, CONFLICT_2WAY)
	if len(p.Hunks) != 1 {
		t.Fatalf("hunks: %d", len(p.Hunks))
	}
	h := p.Hunks[0]
	eqStrings(t, h.Ours, []string{"const timeout = 5000;"})
	eqStrings(t, h.Theirs, []string{"const timeout = 10000;"})
	if h.Base != nil {
		t.Fatal("base should be nil")
	}
	if h.OursLabel != "HEAD" || h.TheirsLabel != "feature" {
		t.Fatalf("labels: %q %q", h.OursLabel, h.TheirsLabel)
	}
}

func TestParseDiff3(t *testing.T) {
	p := mustParse(t, CONFLICT_DIFF3)
	eqStrings(t, p.Hunks[0].Base, []string{"foo(0);"})
	eqStrings(t, p.Hunks[0].Ours, []string{"foo(1);"})
	eqStrings(t, p.Hunks[0].Theirs, []string{"foo(2);"})
}

func TestParseMultiple(t *testing.T) {
	p := mustParse(t, MULTI)
	if len(p.Hunks) != 2 {
		t.Fatalf("hunks: %d", len(p.Hunks))
	}
	if p.Hunks[1].StartLine <= p.Hunks[0].EndLine {
		t.Fatal("hunk order wrong")
	}
}

func TestParseClean(t *testing.T) {
	p := mustParse(t, "no conflict\n")
	if len(p.Hunks) != 0 || HasConflictMarkers("no conflict\n") {
		t.Fatal("clean text should have no hunks")
	}
}

func TestParseUnterminated(t *testing.T) {
	if _, err := ParseConflicts("<<<<<<< a\nx\n"); err == nil {
		t.Fatal("expected ConflictParseError")
	}
}

func TestParseIgnoresMarkerShapedContent(t *testing.T) {
	text := `<<<<<<< ours
Title
=====
theirs stuff
=======
Title2
=================================
more
>>>>>>> theirs
`
	p := mustParse(t, text)
	if len(p.Hunks) != 1 {
		t.Fatalf("hunks: %d", len(p.Hunks))
	}
	eqStrings(t, p.Hunks[0].Ours, []string{"Title", "=====", "theirs stuff"})
	eqStrings(t, p.Hunks[0].Theirs, []string{"Title2", "=================================", "more"})
}

func mkHunk(o func(*ConflictHunk)) ConflictHunk {
	h := ConflictHunk{
		OursLabel: "HEAD", TheirsLabel: "b",
		Ours: []string{"a"}, Theirs: []string{"b"},
	}
	if o != nil {
		o(&h)
	}
	return h
}

func kinds(cs []Candidate) []CandidateKind {
	var out []CandidateKind
	for _, c := range cs {
		out = append(out, c.Kind)
	}
	return out
}

func hasKind(cs []Candidate, k CandidateKind) bool {
	for _, c := range cs {
		if c.Kind == k {
			return true
		}
	}
	return false
}

func findCand(cs []Candidate, k CandidateKind) *Candidate {
	for i := range cs {
		if cs[i].Kind == k {
			return &cs[i]
		}
	}
	return nil
}

func TestEnumerateTwoWay(t *testing.T) {
	// no shared lines: union === both-ours-theirs, so it dedupes away
	cs := EnumerateCandidates(&ConflictHunk{
		Ours: []string{"a"}, Theirs: []string{"b"},
	}, "")
	got := kinds(cs)
	want := []CandidateKind{Ours, Theirs, BothOursTheirs, BothTheirsOurs, Drop}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestEnumerateUnionDistinct(t *testing.T) {
	cs := EnumerateCandidates(&ConflictHunk{
		Ours: []string{"shared", "a"}, Theirs: []string{"shared", "b"},
	}, "")
	if !hasKind(cs, Union) {
		t.Fatal("union missing")
	}
}

func TestEnumerateBase(t *testing.T) {
	cs := EnumerateCandidates(&ConflictHunk{
		Ours: []string{"a"}, Theirs: []string{"b"}, Base: []string{"z"},
	}, "")
	if !hasKind(cs, Base) {
		t.Fatal("base missing")
	}
}

func TestEnumerateDedupes(t *testing.T) {
	cs := EnumerateCandidates(&ConflictHunk{
		Ours: []string{"a"}, Theirs: []string{"b"}, Base: []string{"a"},
	}, "")
	texts := map[string]bool{}
	for _, c := range cs {
		key := strings.Join(c.Lines, "\n")
		if texts[key] {
			t.Fatalf("duplicate candidate text: %q", key)
		}
		texts[key] = true
	}
	if hasKind(cs, Base) {
		t.Fatal("base should dedupe away (same as ours)")
	}
}

func TestEnumerateJSONRepair(t *testing.T) {
	cs := EnumerateCandidates(&ConflictHunk{
		Ours: []string{`"a": 1,`, "}"}, Theirs: []string{`"b": 2,`, "}"},
	}, "f.json")
	eqStrings(t, findCand(cs, Union).Lines, []string{`"a": 1`, "}", `"b": 2,`})
	eqStrings(t, findCand(cs, BothOursTheirs).Lines,
		[]string{`"a": 1`, "}", `"b": 2`, "}"})
}

func TestEnumerateNoRepairTS(t *testing.T) {
	cs := EnumerateCandidates(&ConflictHunk{
		Ours: []string{`"a": 1,`, "}"}, Theirs: []string{`"b": 2,`, "}"},
	}, "f.ts")
	eqStrings(t, findCand(cs, Union).Lines, []string{`"a": 1,`, "}", `"b": 2,`})
}

var testCands = []Candidate{
	{Kind: Ours, Description: "d", Lines: []string{"a"}},
	{Kind: Theirs, Description: "d", Lines: []string{"b"}},
	{Kind: Drop, Description: "d", Lines: []string{}},
}

func mkResult(over map[string]Answer) *SystemOneResult {
	answers := map[string]Answer{
		PICK: {
			Type: "choice", Choice: "ours", Confidence: 0.9,
			Probabilities: map[string]float64{"ours": 0.9, "theirs": 0.05, "drop": 0.05},
		},
		COVERED:           {Type: "noul", Noul: 0.95},
		VerifyKey(Ours):   {Type: "noul", Noul: 0.9},
		VerifyKey(Theirs): {Type: "noul", Noul: 0.1},
		VerifyKey(Drop):   {Type: "noul", Noul: 0.05},
	}
	for k, v := range over {
		answers[k] = v
	}
	return &SystemOneResult{
		Model: "jev-test", Answers: answers,
		Usage: Usage{InputTokens: 1, OutputTokens: 1},
	}
}

func TestInterpretApply(t *testing.T) {
	d := Interpret(mkResult(nil), testCands, nil)
	if d.Action != "apply" || d.Candidate.Kind != Ours {
		t.Fatalf("%+v", d)
	}
}

func TestInterpretCoverageEscalate(t *testing.T) {
	d := Interpret(mkResult(map[string]Answer{
		COVERED: {Type: "noul", Noul: 0.2},
	}), testCands, nil)
	if d.Action != "escalate" || d.Reason != ReasonNotInCandidates {
		t.Fatalf("%+v", d)
	}
}

func TestInterpretNovel(t *testing.T) {
	d := Interpret(mkResult(map[string]Answer{
		PICK: {Type: "choice", Choice: NOVEL, Confidence: 0.8, Probabilities: map[string]float64{}},
	}), testCands, nil)
	if d.Reason != ReasonNovelMerge {
		t.Fatalf("%+v", d)
	}
}

func TestInterpretVerifyFail(t *testing.T) {
	d := Interpret(mkResult(map[string]Answer{
		VerifyKey(Ours): {Type: "noul", Noul: 0.2},
	}), testCands, nil)
	if d.Reason != ReasonVerification {
		t.Fatalf("%+v", d)
	}
}

func TestInterpretLowConfidence(t *testing.T) {
	d := Interpret(mkResult(map[string]Answer{
		PICK: {Type: "choice", Choice: "ours", Confidence: 0.2, Probabilities: map[string]float64{}},
	}), testCands, nil)
	if d.Reason != ReasonLowConfidence {
		t.Fatalf("%+v", d)
	}
}

func TestInterpretLoneHedgeApplies(t *testing.T) {
	d := Interpret(mkResult(map[string]Answer{
		COVERED: {Type: "noul", Noul: 0.45},
	}), testCands, nil)
	if d.Action != "apply" {
		t.Fatalf("%+v", d)
	}
}

func TestInterpretTwoWeakEscalates(t *testing.T) {
	d := Interpret(mkResult(map[string]Answer{
		COVERED: {Type: "noul", Noul: 0.45},
		PICK:    {Type: "choice", Choice: "ours", Confidence: 0.4, Probabilities: map[string]float64{}},
	}), testCands, nil)
	if d.Action != "escalate" || d.Reason != ReasonLowConfidence {
		t.Fatalf("%+v", d)
	}
}

func staticAsker(r *SystemOneResult) Asker {
	return func(context.Context, *SystemOneRequest) (*SystemOneResult, error) {
		return r, nil
	}
}

func TestResolveApplies(t *testing.T) {
	res, err := ResolveText(context.Background(), CONFLICT_2WAY, staticAsker(mkResult(nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 1 || !strings.Contains(res.Text, "const timeout = 5000;") ||
		HasConflictMarkers(res.Text) {
		t.Fatalf("%+v", res)
	}
}

func TestResolveLeavesMarkers(t *testing.T) {
	lowCov := mkResult(map[string]Answer{COVERED: {Type: "noul", Noul: 0.1}})
	res, err := ResolveText(context.Background(), CONFLICT_2WAY, staticAsker(lowCov),
		&ResolveOptions{Decompose: b(false)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Escalated != 1 || !HasConflictMarkers(res.Text) {
		t.Fatalf("%+v", res)
	}
}

func TestResolveMulti(t *testing.T) {
	res, err := ResolveText(context.Background(), MULTI, staticAsker(mkResult(nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Outcomes) != 2 || res.Text != "a\no1\nmid\no2\nz\n" {
		t.Fatalf("%q", res.Text)
	}
}

func TestResolveJSONBoundaryRepair(t *testing.T) {
	// "ours" leaves a trailing comma before "}" — strict JSON can't contain
	// it, so file-level repair drops the comma and the apply stands.
	conflict := "{\n  \"name\": \"x\",\n<<<<<<< HEAD\n  \"a\": 1,\n=======\n  \"b\": 2\n>>>>>>> b\n}\n"
	res, err := ResolveText(context.Background(), conflict, staticAsker(mkResult(nil)),
		&ResolveOptions{HunkContext: HunkContext{FilePath: "f.json"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 1 || HasConflictMarkers(res.Text) {
		t.Fatalf("%+v", res)
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(res.Text), &v); err != nil {
		t.Fatalf("output doesn't parse: %v", err)
	}
	if v["a"] != float64(1) || v["name"] != "x" {
		t.Fatalf("bad json: %v", v)
	}
}

func TestResolveJSONVeto(t *testing.T) {
	// "ours" is truncated — no comma repair can save it, so every apply is
	// vetoed and the markers stay.
	conflict := "{\n  \"name\": \"x\",\n<<<<<<< HEAD\n  \"a\":\n=======\n  \"b\": 2\n>>>>>>> b\n}\n"
	res, err := ResolveText(context.Background(), conflict, staticAsker(mkResult(nil)),
		&ResolveOptions{HunkContext: HunkContext{FilePath: "f.json"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 0 || res.Outcomes[0].Decision.Reason != ReasonInvalidComposition ||
		!HasConflictMarkers(res.Text) {
		t.Fatalf("%+v", res)
	}
}

func TestResolveJSONCSkipsVeto(t *testing.T) {
	conflict := "{\n  // trailing commas are fine here\n<<<<<<< HEAD\n  \"a\": 1,\n=======\n  \"b\": 2\n>>>>>>> b\n}\n"
	res, err := ResolveText(context.Background(), conflict, staticAsker(mkResult(nil)),
		&ResolveOptions{HunkContext: HunkContext{FilePath: "f.json"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 1 || !strings.Contains(res.Text, `"a": 1,`) ||
		HasConflictMarkers(res.Text) {
		t.Fatalf("%+v", res)
	}
}

func TestResolveJSONParsesClean(t *testing.T) {
	conflict := "{\n  \"name\": \"x\",\n<<<<<<< HEAD\n  \"a\": 1\n=======\n  \"b\": 2\n>>>>>>> b\n}\n"
	res, err := ResolveText(context.Background(), conflict, staticAsker(mkResult(nil)),
		&ResolveOptions{HunkContext: HunkContext{FilePath: "f.json"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 1 || HasConflictMarkers(res.Text) {
		t.Fatalf("%+v", res)
	}
}

func TestResolveDupBlockCarriedThrough(t *testing.T) {
	// The block is verbatim in each hunk's ours side — emitting it twice is
	// carried-through, not synthesized.
	blk := strings.Join([]string{
		"alpha_field_one", "alpha_field_two", "alpha_field_three",
		"alpha_field_four", "alpha_field_five",
	}, "\n")
	dup := "a\n<<<<<<< HEAD\n" + blk + "\n=======\nt1\n>>>>>>> b\nmid\n<<<<<<< HEAD\n" + blk + "\n=======\nt2\n>>>>>>> b\nz\n"
	res, err := ResolveText(context.Background(), dup, staticAsker(mkResult(nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 2 || HasConflictMarkers(res.Text) {
		t.Fatalf("%+v", res)
	}
}

func TestResolveDupBlockSynthesizedVeto(t *testing.T) {
	// hunk0's union spans a side boundary, producing a 5-line window that
	// exists in NEITHER side's lines — a synthesized duplicate of the block
	// hunk1 carries verbatim from its source.
	dup := `a
<<<<<<< HEAD
aaa_1
bbb_2
=======
ccc_3
ddd_4
eee_5
>>>>>>> b
mid
<<<<<<< HEAD
aaa_1
bbb_2
ccc_3
ddd_4
eee_5
=======
t2
>>>>>>> b
z
`
	call := 0
	seq := func(context.Context, *SystemOneRequest) (*SystemOneResult, error) {
		call++
		if call == 1 {
			return mkResult(map[string]Answer{
				PICK: {
					Type: "choice", Choice: "both-ours-theirs", Confidence: 0.9,
					Probabilities: map[string]float64{
						"both-ours-theirs": 0.9, "ours": 0.05, "theirs": 0.05,
					},
				},
				VerifyKey(BothOursTheirs): {Type: "noul", Noul: 0.9},
			}), nil
		}
		return mkResult(nil), nil
	}
	res, err := ResolveText(context.Background(), dup, seq, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 1 ||
		res.Outcomes[0].Decision.Reason != ReasonInvalidComposition ||
		res.Outcomes[1].Decision.Action != "apply" ||
		!HasConflictMarkers(res.Text) {
		t.Fatalf("%+v", res.Outcomes)
	}
}

func TestDecomposeAnchors(t *testing.T) {
	h := ConflictHunk{
		Ours: []string{"same", "o1", "also"}, Theirs: []string{"same", "t1", "also"},
	}
	d := DecomposeHunk(&h, 1)
	if d.Windows != 1 {
		t.Fatalf("windows: %d", d.Windows)
	}
	var ks []string
	for _, e := range d.Elements {
		ks = append(ks, e.Kind)
	}
	eqStrings(t, ks, []string{"anchor", "window", "anchor"})
}

func TestDecomposeWindowsApart(t *testing.T) {
	h := ConflictHunk{
		Ours: []string{"A", "o1", "B", "o2", "C"}, Theirs: []string{"A", "t1", "B", "t2", "C"},
	}
	if d := DecomposeHunk(&h, 1); d.Windows != 2 {
		t.Fatalf("windows: %d", d.Windows)
	}
}

func TestDecomposeMergeShortAnchors(t *testing.T) {
	h := ConflictHunk{
		Ours: []string{"A", "o1", "B", "o2", "C"}, Theirs: []string{"A", "t1", "B", "t2", "C"},
	}
	if d := DecomposeHunk(&h, 2); d.Windows != 1 {
		t.Fatalf("windows: %d", d.Windows)
	}
}

func TestDecomposeWindowBase(t *testing.T) {
	h := ConflictHunk{
		Base:   []string{"keep", "old", "end"},
		Ours:   []string{"keep", "new-o", "end"},
		Theirs: []string{"keep", "new-t", "end"},
	}
	d := DecomposeHunk(&h, 1)
	for _, e := range d.Elements {
		if e.Kind == "window" {
			eqStrings(t, e.Base, []string{"old"})
			return
		}
	}
	t.Fatal("no window")
}

func TestLCSPairs(t *testing.T) {
	pairs := LCSPairs([]string{"a", "b", "c"}, []string{"x", "b", "c", "y"})
	if len(pairs) != 2 || pairs[0] != [2]int{1, 1} || pairs[1] != [2]int{2, 2} {
		t.Fatalf("%v", pairs)
	}
}

const INTERLEAVED = `head
<<<<<<< ours
import { a } from "x";
shared();
callOurs();
=======
import { a, b } from "x";
shared();
callTheirs();
extra();
>>>>>>> theirs
tail
`

func pickResult(choice string, over map[string]Answer) *SystemOneResult {
	answers := map[string]Answer{
		PICK:    {Type: "choice", Choice: choice, Confidence: 0.9, Probabilities: map[string]float64{}},
		COVERED: {Type: "noul", Noul: 0.95},
	}
	for k, v := range over {
		answers[k] = v
	}
	return &SystemOneResult{
		Model: "jev-test", Answers: answers,
		Usage: Usage{InputTokens: 1, OutputTokens: 1},
	}
}

func stateOf(req *SystemOneRequest) map[string]any {
	return req.State.(map[string]any)
}

func TestDecomposedSplice(t *testing.T) {
	// Whole-hunk ask fails coverage; window asks pick by content.
	ask := func(_ context.Context, req *SystemOneRequest) (*SystemOneResult, error) {
		st := stateOf(req)
		if !strings.Contains(st["situation"].(string), "one window of a larger conflict") {
			return pickResult("ours", map[string]Answer{
				COVERED: {Type: "noul", Noul: 0.1},
			}), nil
		}
		ours := st["versions"].(map[string]any)["ours"].(string)
		if strings.Contains(ours, "callOurs") {
			return pickResult("ours", nil), nil
		}
		return pickResult("theirs", nil), nil
	}
	res, err := ResolveText(context.Background(), INTERLEAVED, ask, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 1 || res.Outcomes[0].Decision.Candidate.Kind != Spliced ||
		!strings.Contains(res.Text, "callOurs();") ||
		!strings.Contains(res.Text, `import { a, b } from "x";`) ||
		HasConflictMarkers(res.Text) {
		t.Fatalf("%+v\ntext: %s", res.Outcomes[0], res.Text)
	}
}

func TestDecomposedWindowEscalates(t *testing.T) {
	ask := func(_ context.Context, req *SystemOneRequest) (*SystemOneResult, error) {
		return pickResult("ours", map[string]Answer{
			COVERED: {Type: "noul", Noul: 0.1},
		}), nil
	}
	res, err := ResolveText(context.Background(), INTERLEAVED, ask,
		&ResolveOptions{PerLine: b(false)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Escalated != 1 ||
		res.Outcomes[0].Decision.Detail.WholeHunkReason != ReasonNotInCandidates ||
		!HasConflictMarkers(res.Text) {
		t.Fatalf("%+v", res.Outcomes[0])
	}
}

func TestNoRetryWhenDisabled(t *testing.T) {
	calls := 0
	ask := func(context.Context, *SystemOneRequest) (*SystemOneResult, error) {
		calls++
		return pickResult("ours", map[string]Answer{
			COVERED: {Type: "noul", Noul: 0.1},
		}), nil
	}
	_, err := ResolveText(context.Background(), INTERLEAVED, ask, &ResolveOptions{
		Decompose: b(false), SecondOpinion: b(false), PerLine: b(false),
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("calls: %d", calls)
	}
}

func TestSecondOpinionApplies(t *testing.T) {
	calls := 0
	ask := func(context.Context, *SystemOneRequest) (*SystemOneResult, error) {
		calls++
		if calls == 1 {
			return pickResult("ours", map[string]Answer{
				COVERED: {Type: "noul", Noul: 0.1},
			}), nil
		}
		return pickResult("ours", map[string]Answer{
			COVERED: {Type: "noul", Noul: 0.95},
		}), nil
	}
	res, err := ResolveText(context.Background(), INTERLEAVED, ask,
		&ResolveOptions{Decompose: b(false)})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || res.Applied != 1 ||
		!res.Outcomes[0].Decision.Detail.SecondOpinion ||
		res.Outcomes[0].Decision.Candidate.Kind != Ours {
		t.Fatalf("%+v", res.Outcomes[0])
	}
}

func TestSecondOpinionDivergent(t *testing.T) {
	calls := 0
	ask := func(context.Context, *SystemOneRequest) (*SystemOneResult, error) {
		calls++
		if calls == 1 {
			return pickResult("ours", map[string]Answer{
				COVERED: {Type: "noul", Noul: 0.1},
			}), nil
		}
		return pickResult("theirs", map[string]Answer{
			COVERED: {Type: "noul", Noul: 0.95},
		}), nil
	}
	res, err := ResolveText(context.Background(), INTERLEAVED, ask,
		&ResolveOptions{Decompose: b(false), PerLine: b(false)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Escalated != 1 {
		t.Fatalf("%+v", res.Outcomes[0])
	}
}

func TestHeadToHead(t *testing.T) {
	calls := 0
	ask := func(context.Context, *SystemOneRequest) (*SystemOneResult, error) {
		calls++
		if calls == 1 {
			return &SystemOneResult{
				Model: "jev-test",
				Answers: map[string]Answer{
					PICK: {
						Type: "choice", Choice: "ours", Confidence: 0.9,
						Probabilities: map[string]float64{
							"ours": 0.4, "theirs": 0.35, "base": 0.25,
						},
					},
					COVERED: {Type: "noul", Noul: 0.1},
				},
				Usage: Usage{InputTokens: 1, OutputTokens: 1},
			}, nil
		}
		return pickResult("ours", nil), nil
	}
	res, err := ResolveText(context.Background(), INTERLEAVED, ask,
		&ResolveOptions{Decompose: b(false), SecondOpinion: b(false)})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || res.Applied != 1 ||
		!res.Outcomes[0].Decision.Detail.HeadToHead ||
		res.Outcomes[0].Decision.Candidate.Kind != Ours {
		t.Fatalf("%+v", res.Outcomes[0])
	}
}

func TestPerLineComposition(t *testing.T) {
	ask := func(_ context.Context, req *SystemOneRequest) (*SystemOneResult, error) {
		if _, ok := req.Questions["keep_0"]; ok {
			answers := map[string]Answer{}
			for i, n := range []float64{0.9, 0.1, 0.8, 0.9, 0.1} {
				answers[fmt.Sprintf("keep_%d", i)] = Answer{Type: "noul", Noul: n}
			}
			return &SystemOneResult{
				Model: "jev-test", Answers: answers,
				Usage: Usage{InputTokens: 1, OutputTokens: 1},
			}, nil
		}
		if _, ok := req.Questions[VERIFY_SPLICED]; ok {
			return &SystemOneResult{
				Model: "jev-test",
				Answers: map[string]Answer{
					VERIFY_SPLICED: {Type: "noul", Noul: 0.8},
				},
				Usage: Usage{InputTokens: 1, OutputTokens: 1},
			}, nil
		}
		return pickResult("ours", map[string]Answer{
			COVERED: {Type: "noul", Noul: 0.1},
		}), nil
	}
	res, err := ResolveText(context.Background(), INTERLEAVED, ask,
		&ResolveOptions{Decompose: b(false), SecondOpinion: b(false)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != 1 || !res.Outcomes[0].Decision.Detail.PerLine ||
		!strings.Contains(res.Text, `import { a } from "x";`) ||
		!strings.Contains(res.Text, "shared();") ||
		!strings.Contains(res.Text, "callOurs();") ||
		!strings.Contains(res.Text, "callTheirs();") ||
		strings.Contains(res.Text, "extra()") ||
		HasConflictMarkers(res.Text) {
		t.Fatalf("%+v\ntext: %s", res.Outcomes[0], res.Text)
	}
}

func TestPerLineWeavesInBaseOrder(t *testing.T) {
	// theirs replaced base line 0, ours replaced base line 1 — a keep-all
	// composition must emit theirsEdit before oursEdit, which block order
	// could never express.
	const WEAVE = `head
<<<<<<< ours
b0
oursEdit
||||||| base
b0
b1
=======
theirsEdit
b1
>>>>>>> theirs
tail
`
	ask := func(_ context.Context, req *SystemOneRequest) (*SystemOneResult, error) {
		if _, ok := req.Questions["keep_0"]; ok {
			answers := map[string]Answer{}
			for i := 0; i < 4; i++ {
				answers[fmt.Sprintf("keep_%d", i)] = Answer{Type: "noul", Noul: 0.9}
			}
			return &SystemOneResult{
				Model: "jev-test", Answers: answers,
				Usage: Usage{InputTokens: 1, OutputTokens: 1},
			}, nil
		}
		if _, ok := req.Questions[VERIFY_SPLICED]; ok {
			return &SystemOneResult{
				Model: "jev-test",
				Answers: map[string]Answer{
					VERIFY_SPLICED: {Type: "noul", Noul: 0.8},
				},
				Usage: Usage{InputTokens: 1, OutputTokens: 1},
			}, nil
		}
		return pickResult("ours", map[string]Answer{
			COVERED: {Type: "noul", Noul: 0.1},
		}), nil
	}
	res, err := ResolveText(context.Background(), WEAVE, ask,
		&ResolveOptions{Decompose: b(false), SecondOpinion: b(false)})
	if err != nil {
		t.Fatal(err)
	}
	want := "head\nb0\ntheirsEdit\noursEdit\nb1\ntail\n"
	if res.Applied != 1 || res.Text != want {
		t.Fatalf("applied=%d\ngot:  %q\nwant: %q", res.Applied, res.Text, want)
	}
}
