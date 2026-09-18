import * as vscode from "vscode";
import { hasConflictMarkers } from "@fafo/core";
import { ConflictLensProvider } from "./codelens.ts";
import { FafoLog } from "./log.ts";
import { resolveFileInEditor, resolveSingleHunk } from "./run.ts";

export function activate(context: vscode.ExtensionContext): void {
  const log = new FafoLog();
  const lenses = new ConflictLensProvider();

  const updateContext = () => {
    const ed = vscode.window.activeTextEditor;
    vscode.commands.executeCommand(
      "setContext",
      "fafo.hasConflicts",
      !!ed && hasConflictMarkers(ed.document.getText()),
    );
  };

  context.subscriptions.push(
    log,
    lenses,
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lenses),
    vscode.commands.registerCommand("fafo.resolveFile", () =>
      resolveFileInEditor(log, lenses),
    ),
    vscode.commands.registerCommand(
      "fafo.resolveHunk",
      (uri: vscode.Uri, hunkIndex: number) =>
        resolveSingleHunk(uri, hunkIndex, log, lenses),
    ),
    vscode.commands.registerCommand("fafo.showLog", () => log.show()),
    vscode.window.onDidChangeActiveTextEditor(updateContext),
    vscode.workspace.onDidChangeTextDocument((e) => {
      lenses.clearVerdicts(e.document.uri);
      lenses.refresh();
      if (e.document === vscode.window.activeTextEditor?.document) {
        updateContext();
      }
    }),
  );
  updateContext();
}

export function deactivate(): void {}
