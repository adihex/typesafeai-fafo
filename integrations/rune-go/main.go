// Command fafo is a native Rune extension that adjudicates merge
// conflicts with the Go port of @fafo/core linked in-process — no
// subprocess, no npx/tsx child, no workspace executor. Jev selects and
// verifies over an enumerated candidate set; it never generates code.
// Low confidence or failed verification escalates — the hunk keeps its
// markers and lands on the file's location list.
package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/unstablebuild/rune-go-sdk/api/config"
	"github.com/unstablebuild/rune-go-sdk/api/extensionapi"
	"github.com/unstablebuild/rune-go-sdk/api/textapi"
)

func main() {
	meta := extensionapi.Metadata{
		DeveloperID:      "adihex",
		DeveloperKey:     "local",
		DeveloperEmail:   "adihex@users.noreply.github.com",
		ExtensionID:      "fafo",
		ExtensionName:    "FAFO — Jev merge-conflict adjudicator",
		ExtensionVersion: "0.2.0",
		Permissions: extensionapi.NewPermissions(
			extensionapi.PermissionCommands,
			extensionapi.PermissionEditor,
			extensionapi.PermissionFileSystem,
			extensionapi.PermissionNotifications,
		),
	}

	if err := extensionapi.ServeWorkspaceExtension(
		extensionapi.FuncWorkspaceExtension(run), meta,
	); err != nil {
		slog.Error("fafo exited", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, ws *extensionapi.Workspace, cfg config.Config) error {
	h := &handler{
		fs:    ws.FileSystem(ctx),
		ed:    ws.Editor(ctx),
		notes: ws.Notifications(ctx),
		ask:   newAsker(cfg),
	}

	manual := textapi.CommandManual{
		Name:     "fafo",
		Summary:  "Resolve merge conflicts — Jev picks from enumerated candidates",
		Synopsis: "[check|all]",
		Commands: []textapi.CommandManual{
			{Name: "check", Summary: "Dry-run: report decisions without writing"},
			{Name: "all", Summary: "Resolve every conflicted file in the workspace"},
		},
	}
	if err := ws.RegisterCommand(manual, textapi.NopCommandCompleter(h.handle)); err != nil {
		return err
	}
	slog.Info("fafo extension ready (in-process resolver)")
	return nil
}
