package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	core "github.com/adihex/typesafeai-fafo/packages/core-go"
	"github.com/unstablebuild/rune-go-sdk/api/browserapi"
	"github.com/unstablebuild/rune-go-sdk/api/config"
	"github.com/unstablebuild/rune-go-sdk/api/textapi"
	"github.com/unstablebuild/rune-go-sdk/api/workspaceapi"
	"github.com/unstablebuild/rune-go-sdk/term"
)

// handler resolves conflicts via the in-process core. Resolver policy
// lives in core-go; this file only adapts Rune's API to it.
type handler struct {
	fs    workspaceapi.FileSystem
	ed    textapi.Editor
	notes browserapi.Notifications
	ask   core.Asker
}

// newAsker builds the Jev asker. Key resolution order: process env
// TYPESAFE_API_KEY → config fafo.api_key → env file at fafo.env_file /
// FAFO_ENV_FILE / ~/.config/fafo/.env.
func newAsker(cfg config.Config) core.Asker {
	key := os.Getenv("TYPESAFE_API_KEY")
	base := os.Getenv("TYPESAFE_BASE_URL")
	model := os.Getenv("TYPESAFE_DEFAULT_MODEL")

	if key == "" {
		if c, err := cfg.GetConfig("fafo"); err == nil {
			if k, _ := c.GetString("api_key"); k != "" {
				key = k
			}
		}
	}
	if key == "" || base == "" {
		envFile := os.Getenv("FAFO_ENV_FILE")
		if c, err := cfg.GetConfig("fafo"); err == nil {
			if envFile == "" {
				envFile, _ = c.GetString("env_file")
			}
			if base == "" {
				base, _ = c.GetString("api_base")
			}
			if model == "" {
				model, _ = c.GetString("model")
			}
		}
		if envFile == "" {
			if home, err := os.UserHomeDir(); err == nil {
				envFile = filepath.Join(home, ".config", "fafo", ".env")
			}
		}
		if kv := readEnvFile(envFile); kv != nil {
			if key == "" {
				key = kv["TYPESAFE_API_KEY"]
			}
			if base == "" {
				base = kv["TYPESAFE_BASE_URL"]
			}
			if model == "" {
				model = kv["TYPESAFE_DEFAULT_MODEL"]
			}
		}
	}
	return core.HTTPAsker(key, base, model, nil)
}

// readEnvFile parses KEY=VALUE lines; ignores comments/blank lines.
func readEnvFile(p string) map[string]string {
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	out := map[string]string{}
	for _, l := range strings.Split(string(data), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		k, v, ok := strings.Cut(l, "=")
		if ok {
			out[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
		}
	}
	return out
}

var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true,
	"dist": true, "build": true, ".venv": true, "target": true,
	"__pycache__": true,
}

// conflictedFiles walks the workspace root and returns paths containing
// conflict markers. Pure Go — no git subprocess; a file with live
// markers is exactly what we resolve.
func (h *handler) conflictedFiles(root string) ([]string, error) {
	var out []string
	var walk func(dir string) error
	walk = func(dir string) error {
		ents, err := h.fs.ReadDir(dir)
		if err != nil {
			return nil // unreadable dir — skip, don't fail the scan
		}
		for _, e := range ents {
			p := path.Join(dir, e.Name())
			if e.IsDir() {
				if !skipDirs[e.Name()] {
					if err := walk(p); err != nil {
						return err
					}
				}
				continue
			}
			f, err := h.fs.OpenFile(p, os.O_RDONLY, 0)
			if err != nil {
				continue
			}
			data, err := io.ReadAll(io.LimitReader(f, 4<<20))
			f.Close()
			if err == nil && core.HasConflictMarkers(string(data)) {
				out = append(out, p)
			}
		}
		return nil
	}
	if err := walk(root); err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

func (h *handler) readFile(p string) (string, error) {
	f, err := h.fs.OpenFile(p, os.O_RDONLY, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	return string(data), err
}

func (h *handler) writeFile(p, text string) error {
	f, err := h.fs.OpenFile(p, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write([]byte(text))
	return err
}

// markerRows returns 0-based rows where <<<<<<< markers remain —
// i.e. escalated hunks after resolution.
func markerRows(text string) []int {
	var rows []int
	for i, l := range strings.Split(text, "\n") {
		if strings.HasPrefix(l, "<<<<<<<") {
			rows = append(rows, i)
		}
	}
	return rows
}

func (h *handler) setEscalatedLocations(ctx context.Context, p, text string) {
	rows := markerRows(text)
	if len(rows) == 0 {
		return
	}
	uri, err := h.fs.URI(p)
	if err != nil {
		return
	}
	e, err := h.ed.Editor(uri)
	if err != nil {
		return
	}
	locs := make([]textapi.Location, len(rows))
	for i, r := range rows {
		locs[i] = textapi.Location{
			From:    term.Coordinates{X: 0, Y: r},
			To:      term.Coordinates{X: 0, Y: r},
			Message: "escalated — resolve manually or with a generative model",
			Icon:    "!",
		}
	}
	_ = h.ed.SetLocationList(e, textapi.LocationPriorityError, "fafo",
		textapi.LocationSlice(locs))
}

func (h *handler) resolveFile(ctx context.Context, p string, check bool) (applied, escalated int, err error) {
	text, err := h.readFile(p)
	if err != nil {
		return 0, 0, err
	}
	parsed, err := core.ParseConflicts(text)
	if err != nil {
		return 0, 0, err
	}
	if len(parsed.Hunks) == 0 {
		return 0, 0, nil
	}
	res, err := core.ResolveText(ctx, text, h.ask,
		&core.ResolveOptions{HunkContext: core.HunkContext{FilePath: p}})
	if err != nil {
		return 0, 0, err
	}

	name := filepath.Base(p)
	for _, o := range res.Outcomes {
		d := o.Decision
		if d.Action == "apply" {
			conf := ""
			if d.Detail.Confidence != nil {
				conf = fmt.Sprintf(" conf %.2f", *d.Detail.Confidence)
			}
			h.note(ctx, browserapi.LevelSuccess,
				"fafo: %s: %s%s", name, d.Candidate.Kind, conf)
		} else {
			h.note(ctx, browserapi.LevelWarn,
				"fafo: %s: escalated — %s", name, d.Reason)
		}
	}

	if !check && res.Applied > 0 {
		if err := h.writeFile(p, res.Text); err != nil {
			return 0, 0, err
		}
	}
	h.setEscalatedLocations(ctx, p, res.Text)
	return res.Applied, res.Escalated, nil
}

func (h *handler) note(ctx context.Context, lvl browserapi.NotificationLevel,
	msg string, args ...any) {
	if _, err := h.notes.Notify(lvl, msg, args...); err != nil {
		slog.Warn("notify failed", "error", err)
	}
}

func (h *handler) handle(ctx context.Context, cmd textapi.Command) error {
	check := false
	all := false
	for _, a := range cmd.Args {
		switch a {
		case "check":
			check = true
		case "all":
			all = true
		}
	}

	var targets []string
	if all {
		root := ""
		if uri, err := h.fs.URI("."); err == nil {
			root = uri.Path()
		}
		if root == "" || root == "/" {
			if cmd.URI.Scheme() == "file" || cmd.URI.Scheme() == "ws" {
				root = filepath.Dir(cmd.URI.Path())
			}
		}
		if root == "" {
			return fmt.Errorf("fafo: cannot locate workspace root")
		}
		files, err := h.conflictedFiles(root)
		if err != nil {
			return err
		}
		targets = files
	} else {
		if cmd.URI.Scheme() != "file" && cmd.URI.Scheme() != "ws" {
			h.note(ctx, browserapi.LevelWarn,
				"fafo: no file context — use `fafo all`")
			return nil
		}
		p := cmd.URI.Path()
		if !path.IsAbs(p) {
			if rootURI, err := h.fs.URI("."); err == nil {
				p = path.Join(rootURI.Path(), strings.TrimPrefix(p, "/"))
			}
		}
		targets = []string{p}
	}

	if len(targets) == 0 {
		h.note(ctx, browserapi.LevelInfo, "fafo: no conflicted files")
		return nil
	}
	h.note(ctx, browserapi.LevelInfo, "fafo: %s %d file(s)…",
		map[bool]string{true: "checking", false: "resolving"}[check], len(targets))

	applied, escalated := 0, 0
	var failures []string
	for _, p := range targets {
		a, e, err := h.resolveFile(ctx, p, check)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", filepath.Base(p), err))
			continue
		}
		applied += a
		escalated += e
	}
	for _, f := range failures {
		h.note(ctx, browserapi.LevelError, "fafo: %s", f)
	}

	lvl := browserapi.LevelSuccess
	if escalated > 0 || len(failures) > 0 {
		lvl = browserapi.LevelWarn
	}
	verb := "applied"
	if check {
		verb = "would apply"
	}
	h.note(ctx, lvl, "fafo: %d hunk(s) %s, %d escalated", applied, verb, escalated)
	return nil
}
