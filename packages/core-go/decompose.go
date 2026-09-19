package core

import (
	"strings"
	"unicode"
)

// Intra-hunk decomposition: align ours vs theirs so a conflicted region
// splits into shared "anchor" lines and minimal "windows" of disagreement.
// Each window is enumerable by the flat candidate set, which makes
// line-level interleavings — the dominant not-in-candidates failure —
// expressible. For diff3 hunks each window also recovers the base lines it
// replaced, via base→side alignments.

// Element is an anchor (Kind == "anchor", Lines set) or a window
// (Kind == "window", Ours/Theirs/Base set). Base is nil for two-way hunks.
type Element struct {
	Kind   string
	Lines  []string // anchor
	Ours   []string // window
	Theirs []string // window
	Base   []string // window; nil for two-way
}

type DecomposedHunk struct {
	Elements []Element
	Windows  int
}

func trimKey(l string) string {
	return strings.TrimRightFunc(l, unicode.IsSpace)
}

func eqSpan(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if trimKey(a[i]) != trimKey(b[i]) {
			return false
		}
	}
	return true
}

// LCSPairs returns LCS match pairs between a and b as increasing [ai, bi]
// index pairs.
func LCSPairs(a, b []string) [][2]int {
	n, m := len(a), len(b)
	if n == 0 || m == 0 {
		return nil
	}
	w := m + 1
	t := make([]int, (n+1)*w)
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if trimKey(a[i]) == trimKey(b[j]) {
				t[i*w+j] = t[(i+1)*w+j+1] + 1
			} else if t[(i+1)*w+j] >= t[i*w+j+1] {
				t[i*w+j] = t[(i+1)*w+j]
			} else {
				t[i*w+j] = t[i*w+j+1]
			}
		}
	}
	var pairs [][2]int
	i, j := 0, 0
	for i < n && j < m {
		if trimKey(a[i]) == trimKey(b[j]) {
			pairs = append(pairs, [2]int{i, j})
			i++
			j++
		} else if t[(i+1)*w+j] >= t[i*w+j+1] {
			i++
		} else {
			j++
		}
	}
	return pairs
}

// BaseAnchors: base position each side-line replaces, as the midpoint
// between its flanking base→side LCS matches. Used to order keep/drop
// composition so theirs-before-ours interleaves are expressible.
func BaseAnchors(base, side []string) []float64 {
	pairs := LCSPairs(base, side)
	at := map[int]int{}
	for _, p := range pairs {
		at[p[1]] = p[0]
	}
	anchors := make([]float64, 0, len(side))
	pi, prev := 0, -1
	for j := 0; j < len(side); j++ {
		if m, ok := at[j]; ok {
			anchors = append(anchors, float64(m))
			prev = m
			pi++
			continue
		}
		next := float64(len(base))
		if pi < len(pairs) {
			next = float64(pairs[pi][0])
		}
		anchors = append(anchors, (float64(prev)+next)/2)
	}
	return anchors
}

// prevBoundary: bi of the last pair whose side-index is < pos, else -1.
func prevBoundary(pairs [][2]int, pos int) int {
	lo, hi, ans := 0, len(pairs)-1, -1
	for lo <= hi {
		mid := (lo + hi) >> 1
		if pairs[mid][1] < pos {
			ans = pairs[mid][0]
			lo = mid + 1
		} else {
			hi = mid - 1
		}
	}
	return ans
}

// nextBoundary: bi of the first pair whose side-index is >= pos, else
// fallback.
func nextBoundary(pairs [][2]int, pos int, fallback int) int {
	lo, hi, ans := 0, len(pairs)-1, fallback
	for lo <= hi {
		mid := (lo + hi) >> 1
		if pairs[mid][1] >= pos {
			ans = pairs[mid][0]
			hi = mid - 1
		} else {
			lo = mid + 1
		}
	}
	return ans
}

// baseSpanForWindow: union of the base ranges each side's alignment says
// this window replaced.
func baseSpanForWindow(base []string, oPairs, tPairs [][2]int, o1, o2, t1, t2 int) []string {
	lo := prevBoundary(oPairs, o1)
	if v := prevBoundary(tPairs, t1); v < lo {
		lo = v
	}
	lo++
	hi := nextBoundary(oPairs, o2, len(base))
	if v := nextBoundary(tPairs, t2, len(base)); v > hi {
		hi = v
	}
	if lo < 0 {
		lo = 0
	}
	if hi > len(base) {
		hi = len(base)
	}
	if lo >= hi {
		return []string{}
	}
	return base[lo:hi]
}

// mergeShortAnchors merges windows separated by fewer than minAnchor
// shared lines so Jev sees coherent regions instead of choppy one-line
// decisions.
func mergeShortAnchors(elements []Element, minAnchor int) []Element {
	for i := 1; i < len(elements)-1; i++ {
		e := elements[i]
		if e.Kind != "anchor" || len(e.Lines) >= minAnchor {
			continue
		}
		prev, next := &elements[i-1], elements[i+1]
		if prev.Kind != "window" || next.Kind != "window" {
			continue
		}
		prev.Ours = append(append(append([]string{}, prev.Ours...), e.Lines...), next.Ours...)
		prev.Theirs = append(append(append([]string{}, prev.Theirs...), e.Lines...), next.Theirs...)
		if prev.Base == nil || next.Base == nil {
			prev.Base = nil
		} else {
			prev.Base = append(append(append([]string{}, prev.Base...), e.Lines...), next.Base...)
		}
		elements = append(elements[:i], elements[i+2:]...)
		i--
	}
	return elements
}

// DecomposeHunk splits a hunk into anchors + windows by aligning
// ours↔theirs. For diff3 hunks each window also gets the base lines it
// replaced (as a window-level base candidate).
func DecomposeHunk(hunk *ConflictHunk, minAnchor int) DecomposedHunk {
	var elements []Element
	pairs := LCSPairs(hunk.Ours, hunk.Theirs)
	var oPairs, tPairs [][2]int
	if hunk.Base != nil {
		oPairs = LCSPairs(hunk.Base, hunk.Ours)
		tPairs = LCSPairs(hunk.Base, hunk.Theirs)
	}

	pushWindow := func(o1, o2, t1, t2 int) {
		ours := hunk.Ours[o1:o2]
		theirs := hunk.Theirs[t1:t2]
		if eqSpan(ours, theirs) {
			if len(ours) > 0 {
				elements = append(elements, Element{Kind: "anchor", Lines: ours})
			}
			return
		}
		var base []string
		if hunk.Base != nil {
			base = baseSpanForWindow(hunk.Base, oPairs, tPairs, o1, o2, t1, t2)
		}
		elements = append(elements, Element{Kind: "window", Ours: ours, Theirs: theirs, Base: base})
	}

	po, pt := 0, 0
	for _, p := range pairs {
		pushWindow(po, p[0], pt, p[1])
		elements = append(elements, Element{Kind: "anchor", Lines: []string{hunk.Ours[p[0]]}})
		po, pt = p[0]+1, p[1]+1
	}
	pushWindow(po, len(hunk.Ours), pt, len(hunk.Theirs))

	elements = mergeShortAnchors(elements, minAnchor)
	windows := 0
	for _, e := range elements {
		if e.Kind == "window" {
			windows++
		}
	}
	return DecomposedHunk{Elements: elements, Windows: windows}
}
