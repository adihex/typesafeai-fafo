import * as vscode from "vscode";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  ConflictParseError,
  hasConflictMarkers,
  resolveText,
  type Asker,
  type ResolveOptions,
} from "@fafo/core";
import type { ConflictLensProvider } from "./codelens.ts";
import {
  resolvedStartLines,
  singleHunkText,
  tryParseConflicts,
  verdictText,
} from "./hunks.ts";
import type { FafoLog } from "./log.ts";
import { resolveApiKey, toResolveOptions, type FafoSettings } from "./settings.ts";

function readSettings(): FafoSettings {
  const c = vscode.workspace.getConfiguration("fafo");
  return {
    apiKey: c.get<string>("apiKey"),
    minConfidence: c.get<number>("minConfidence"),
    minCoverage: c.get<number>("minCoverage"),
    minVerify: c.get<number>("minVerify"),
    noVerify: c.get<boolean>("noVerify"),
    decompose: c.get<boolean>("decompose"),
    maxWindows: c.get<number>("maxWindows"),
    contextLines: c.get<number>("contextLines"),
    model: c.get<string>("model"),
  };
}

async function askerOrWarn(): Promise<Asker | undefined> {
  const settings = readSettings();
  const key = resolveApiKey(process.env.TYPESAFE_API_KEY, settings.apiKey);
  if (!key) {
    const pick = await vscode.window.showErrorMessage(
      "FAFO: no TypeSafe API key. Set TYPESAFE_API_KEY in the environment or the fafo.apiKey setting.",
      "Open Settings",
    );
    if (pick) {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "fafo.apiKey",
      );
    }
    return undefined;
  }
  try {
    const client = new TypeSafeClient({ apiKey: key });
    return (req) => client.systemOne(req) as never;
  } catch (err) {
    vscode.window.showErrorMessage(
      `FAFO: could not create TypeSafe client — ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function filePathFor(doc: vscode.TextDocument): string {
  return vscode.workspace.asRelativePath(doc.uri, false);
}

/** Docs currently mid-resolve; blocks re-entrant asks on the same file. */
const busy = new Set<string>();

function wholeRange(doc: vscode.TextDocument): vscode.Range {
  const last = doc.lineAt(doc.lineCount - 1);
  return new vscode.Range(0, 0, doc.lineCount - 1, last.text.length);
}

function clampLine(doc: vscode.TextDocument, line: number): number {
  return Math.max(0, Math.min(line, doc.lineCount - 1));
}

/** "FAFO: Resolve conflicts in this file" — resolveText over the whole document. */
export async function resolveFileInEditor(
  log: FafoLog,
  lenses: ConflictLensProvider,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const key = doc.uri.toString();
  if (busy.has(key)) {
    vscode.window.showInformationMessage("FAFO: already resolving this file.");
    return;
  }

  const text = doc.getText();
  if (!hasConflictMarkers(text)) {
    vscode.window.showInformationMessage("FAFO: no conflict markers in this file.");
    return;
  }
  const parsed = tryParseConflicts(text);
  if (!parsed) {
    vscode.window.showErrorMessage("FAFO: conflict markers are malformed; fix them manually.");
    return;
  }
  const ask = await askerOrWarn();
  if (!ask) return;

  const opts: ResolveOptions = {
    ...toResolveOptions(readSettings()),
    filePath: filePathFor(doc),
  };
  const file = filePathFor(doc);
  const version = doc.version;
  busy.add(key);
  try {
    const res = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "FAFO: Jev resolving conflicts…",
        cancellable: false,
      },
      () => resolveText(text, ask, opts),
    );

    log.line(`${file}: ${res.applied} applied, ${res.escalated} escalated`);
    for (const o of res.outcomes) log.outcome(file, o);

    if (doc.version !== version) {
      log.line(`${file}: document changed during resolution; not writing results`);
      vscode.window.showWarningMessage(
        "FAFO: document changed while Jev was thinking — nothing written. Re-run to resolve.",
      );
      return;
    }

    if (res.applied > 0) {
      const ok = await editor.edit((b) => b.replace(wholeRange(doc), res.text));
      if (!ok) {
        vscode.window.showErrorMessage("FAFO: edit was rejected by the editor.");
        return;
      }
    }

    // Anchor verdicts at post-resolution line positions.
    const lines = resolvedStartLines(res.outcomes);
    res.outcomes.forEach((o, i) => {
      lenses.setVerdict(doc.uri, clampLine(doc, lines[i]), verdictText(o));
    });

    vscode.window.showInformationMessage(
      res.escalated
        ? `FAFO: ${res.applied} hunk(s) resolved, ${res.escalated} escalated (markers kept).`
        : `FAFO: ${res.applied} hunk(s) resolved.`,
    );
  } catch (err) {
    const msg = err instanceof ConflictParseError
      ? `malformed conflict markers (line ${err.line + 1}): ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    log.line(`${file}: resolve failed — ${msg}`);
    vscode.window.showErrorMessage(`FAFO: ${msg}`);
  } finally {
    busy.delete(key);
  }
}

/** CodeLens command — resolve one hunk in place via a single-hunk document. */
export async function resolveSingleHunk(
  uri: vscode.Uri,
  hunkIndex: number,
  log: FafoLog,
  lenses: ConflictLensProvider,
): Promise<void> {
  const key = uri.toString();
  if (busy.has(key)) {
    vscode.window.showInformationMessage("FAFO: already resolving this file.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const text = doc.getText();
  const parsed = tryParseConflicts(text);
  if (!parsed || hunkIndex >= parsed.hunks.length) {
    vscode.window.showWarningMessage("FAFO: conflicts changed since the lens was drawn — re-run.");
    lenses.refresh();
    return;
  }
  const ask = await askerOrWarn();
  if (!ask) return;

  const settings = readSettings();
  const opts = toResolveOptions(settings);
  const file = filePathFor(doc);
  const hunk = parsed.hunks[hunkIndex];
  const version = doc.version;
  busy.add(key);
  try {
    // resolveText wants a document; give it this hunk plus real context,
    // clamped inside neighboring hunks (see singleHunkText).
    const ctx = (opts.contextLines ?? 15) + 8;
    const sub = singleHunkText(parsed, hunkIndex, ctx);
    const res = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `FAFO: Jev resolving hunk ${hunkIndex}…`,
        cancellable: false,
      },
      () => resolveText(sub, ask, { ...opts, filePath: file }),
    );
    const o = res.outcomes[0];
    o.hunkIndex = hunkIndex;
    o.hunk = hunk;
    log.outcome(file, o);

    if (o.decision.action === "apply" && o.decision.candidate) {
      if (doc.version !== version) {
        vscode.window.showWarningMessage(
          "FAFO: document changed while Jev was thinking — nothing written.",
        );
        return;
      }
      const lines = o.decision.candidate.lines;
      const edit = new vscode.WorkspaceEdit();
      if (hunk.endLine < doc.lineCount) {
        edit.replace(
          uri,
          new vscode.Range(hunk.startLine, 0, hunk.endLine, 0),
          lines.length ? `${lines.join("\n")}\n` : "",
        );
      } else {
        const last = doc.lineAt(doc.lineCount - 1);
        edit.replace(
          uri,
          new vscode.Range(hunk.startLine, 0, doc.lineCount - 1, last.text.length),
          lines.join("\n"),
        );
      }
      if (!(await vscode.workspace.applyEdit(edit))) {
        vscode.window.showErrorMessage("FAFO: edit was rejected by the editor.");
        return;
      }
    }
    lenses.setVerdict(uri, clampLine(doc, hunk.startLine), verdictText(o));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.line(`${file} hunk${hunkIndex}: resolve failed — ${msg}`);
    vscode.window.showErrorMessage(`FAFO: ${msg}`);
  } finally {
    busy.delete(key);
  }
}
