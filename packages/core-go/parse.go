package core

import (
	"fmt"
	"regexp"
	"strings"
)

// Git emits exactly 7 marker chars; longer runs (setext underlines, ASCII
// rules) inside conflict content must not read as markers.
var (
	markerRe = regexp.MustCompile(`(?m)^<{7}( |$)|^={7}$|^>{7}( |$)|^\|{7}( |$)`)
	openRe   = regexp.MustCompile(`^<{7}( |$)`)
	baseRe   = regexp.MustCompile(`^\|{7}( |$)`)
	sepRe    = regexp.MustCompile(`^={7}$`)
	closeRe  = regexp.MustCompile(`^>{7}( |$)`)
)

func HasConflictMarkers(text string) bool { return markerRe.MatchString(text) }

// ConflictParseError reports unbalanced markers; callers should treat it as
// escalate-everything.
type ConflictParseError struct {
	Line int
	Msg  string
}

func (e *ConflictParseError) Error() string {
	return fmt.Sprintf("%s (line %d)", e.Msg, e.Line+1)
}

func markerLabel(line string) string {
	i := strings.IndexByte(line, ' ')
	if i == -1 {
		return ""
	}
	return strings.TrimSpace(line[i+1:])
}

// ParseConflicts parses two-way and diff3 (||||||| base section) markers.
func ParseConflicts(text string) (*ParsedConflicts, error) {
	lines := strings.Split(text, "\n")
	var hunks []ConflictHunk

	for i := 0; i < len(lines); i++ {
		if !openRe.MatchString(lines[i]) {
			continue
		}
		hunk := ConflictHunk{StartLine: i, EndLine: -1, OursLabel: markerLabel(lines[i])}
		section := 0 // 0 = ours, 1 = base, 2 = theirs
		closed := false
		for j := i + 1; j < len(lines); j++ {
			l := lines[j]
			if openRe.MatchString(l) {
				return nil, &ConflictParseError{Line: j, Msg: "nested conflict marker"}
			}
			if baseRe.MatchString(l) {
				if section != 0 {
					return nil, &ConflictParseError{Line: j, Msg: "base marker out of place"}
				}
				section = 1
				hunk.Base = []string{}
				continue
			}
			if sepRe.MatchString(l) {
				if section == 2 {
					return nil, &ConflictParseError{Line: j, Msg: "duplicate separator"}
				}
				section = 2
				continue
			}
			if closeRe.MatchString(l) {
				if section != 2 {
					return nil, &ConflictParseError{Line: j, Msg: "no separator in conflict"}
				}
				hunk.TheirsLabel = markerLabel(l)
				hunk.EndLine = j + 1
				closed = true
				i = j
				break
			}
			switch section {
			case 0:
				hunk.Ours = append(hunk.Ours, l)
			case 1:
				hunk.Base = append(hunk.Base, l)
			default:
				hunk.Theirs = append(hunk.Theirs, l)
			}
		}
		if !closed {
			return nil, &ConflictParseError{Line: hunk.StartLine, Msg: "unterminated conflict"}
		}
		hunks = append(hunks, hunk)
	}
	return &ParsedConflicts{Lines: lines, Hunks: hunks}, nil
}
