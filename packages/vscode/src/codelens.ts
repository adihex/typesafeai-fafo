import * as vscode from "vscode";
import { tryParseConflicts } from "./hunks.ts";

/**
 * Lenses over every `<<<<<<<` marker: "Resolve with Jev" per hunk (plus
 * "Resolve all" on the first), and verdict text after a hunk is resolved.
 * Verdicts are keyed by document line; the extension clears them whenever the
 * document changes, since positions go stale.
 */
export class ConflictLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  private verdicts = new Map<string, Map<number, string>>();

  setVerdict(uri: vscode.Uri, line: number, text: string): void {
    const key = uri.toString();
    let m = this.verdicts.get(key);
    if (!m) this.verdicts.set(key, (m = new Map()));
    m.set(line, text);
    this.emitter.fire();
  }

  clearVerdicts(uri: vscode.Uri): void {
    if (this.verdicts.delete(uri.toString())) this.emitter.fire();
  }

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const vmap = this.verdicts.get(document.uri.toString());
    const parsed = tryParseConflicts(document.getText());
    const markerLines = new Set<number>();

    if (parsed) {
      parsed.hunks.forEach((h, i) => {
        markerLines.add(h.startLine);
        const range = new vscode.Range(h.startLine, 0, h.startLine, 0);
        const verdict = vmap?.get(h.startLine);
        if (verdict) {
          lenses.push(
            new vscode.CodeLens(range, { title: verdict, command: "" }),
            new vscode.CodeLens(range, {
              title: "Retry with Jev",
              command: "fafo.resolveHunk",
              arguments: [document.uri, i],
            }),
          );
        } else {
          lenses.push(
            new vscode.CodeLens(range, {
              title: "Resolve with Jev",
              command: "fafo.resolveHunk",
              arguments: [document.uri, i],
            }),
          );
        }
        if (i === 0) {
          lenses.push(
            new vscode.CodeLens(range, {
              title: "Resolve all with Jev",
              command: "fafo.resolveFile",
            }),
          );
        }
      });
    }

    // Verdicts on lines that no longer carry a marker (applied hunks).
    if (vmap) {
      for (const [line, text] of vmap) {
        if (markerLines.has(line) || line >= document.lineCount) continue;
        lenses.push(
          new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
            title: text,
            command: "",
          }),
        );
      }
    }
    return lenses;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
