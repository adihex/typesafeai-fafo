import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  hasConflictMarkers,
  parseConflicts,
  resolveText,
  type Asker,
  type ResolveOptions,
} from "@fafo/core";
import { conflictedPaths } from "./git.ts";

/**
 * MCP hosts spawn the server without a login shell, so TYPESAFE_API_KEY
 * exported in ~/.zshrc never arrives. Fall back to the repo's gitignored
 * .env (same convention the CLI workers use) — never write the key into
 * MCP client config files.
 */
export function loadRepoEnv(): void {
  if (process.env.TYPESAFE_API_KEY) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const dotenv = resolvePath(here, "../../../.env");
  if (!existsSync(dotenv)) return;
  for (const line of readFileSync(dotenv, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}

export function makeAsker(): Asker {
  const client = new TypeSafeClient();
  return (req) => client.systemOne(req) as never;
}

export interface ScanResult {
  files: { path: string; hunks: number }[];
  totalHunks: number;
  /** Explicitly-requested files with no conflict markers (or unreadable). */
  skipped: string[];
}

/** Conflicted files + hunk counts. No API key needed — pure parsing. */
export function scanConflicts(cwd: string, files?: string[]): ScanResult {
  const paths = files?.length ? files : conflictedPaths(cwd);
  const out: ScanResult["files"] = [];
  const skipped: string[] = [];
  let totalHunks = 0;
  for (const file of paths) {
    const abs = resolvePath(cwd, file);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      skipped.push(file);
      continue;
    }
    if (!hasConflictMarkers(text)) {
      skipped.push(file);
      continue;
    }
    const parsed = parseConflicts(text);
    out.push({ path: file, hunks: parsed.hunks.length });
    totalHunks += parsed.hunks.length;
  }
  return { files: out, totalHunks, skipped };
}

export interface McpResolveOpts extends ResolveOptions {
  cwd: string;
  files?: string[];
  /** Report decisions without writing. */
  check?: boolean;
}

export interface FileReport {
  file: string;
  /** resolved = all hunks applied; escalated = markers remain;
   *  skipped-clean = no conflict markers found; error = unreadable. */
  status: "resolved" | "escalated" | "skipped-clean" | "error";
  applied: number;
  escalated: number;
  /** Jev token spend across all asks for this file, when the asker reports it. */
  usage?: { input_tokens: number; output_tokens: number };
  outcomes: {
    hunk: number;
    action: string;
    candidate?: string;
    reason?: string;
    confidence?: number;
    coverage?: number;
    error?: string;
  }[];
}

export interface McpResolveResult {
  files: FileReport[];
  applied: number;
  escalated: number;
  written: string[];
  markersLeftIn: string[];
  /** Explicitly-requested files skipped because they carry no markers. */
  skipped: string[];
  /** Total Jev token spend for the call, when reported. */
  usage: { input_tokens: number; output_tokens: number };
}

/** The resolve loop as a pure-ish function — same shape as `resolve --json`. */
export async function resolveFiles(
  o: McpResolveOpts,
  ask: Asker,
): Promise<McpResolveResult> {
  const paths = o.files?.length ? o.files : conflictedPaths(o.cwd);
  const result: McpResolveResult = {
    files: [],
    applied: 0,
    escalated: 0,
    written: [],
    markersLeftIn: [],
    skipped: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  for (const file of paths) {
    const abs = resolvePath(o.cwd, file);
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      result.files.push({
        file,
        status: "error",
        applied: 0,
        escalated: 0,
        outcomes: [{ hunk: -1, action: "escalate", reason: "ask-failed", error: "unreadable file" }],
      });
      continue;
    }
    if (!hasConflictMarkers(text)) {
      result.skipped.push(file);
      result.files.push({ file, status: "skipped-clean", applied: 0, escalated: 0, outcomes: [] });
      continue;
    }
    const res = await resolveText(text, ask, { ...o, filePath: file });
    result.applied += res.applied;
    result.escalated += res.escalated;
    if (res.escalated > 0) result.markersLeftIn.push(file);
    const usage = res.outcomes.reduce(
      (acc, x) => ({
        input_tokens: acc.input_tokens + (x.usage?.input_tokens ?? 0),
        output_tokens: acc.output_tokens + (x.usage?.output_tokens ?? 0),
      }),
      { input_tokens: 0, output_tokens: 0 },
    );
    result.usage.input_tokens += usage.input_tokens;
    result.usage.output_tokens += usage.output_tokens;
    result.files.push({
      file,
      status: res.escalated > 0 ? "escalated" : "resolved",
      applied: res.applied,
      escalated: res.escalated,
      ...(usage.input_tokens || usage.output_tokens ? { usage } : {}),
      outcomes: res.outcomes.map((x) => ({
        hunk: x.hunkIndex,
        action: x.decision.action,
        candidate: x.decision.candidate?.kind,
        reason: x.decision.reason,
        confidence: x.decision.detail.confidence,
        coverage: x.decision.detail.coverage,
        error: x.decision.detail.error,
      })),
    });
    if (!o.check && res.applied > 0) {
      writeFileSync(abs, res.text);
      result.written.push(file);
    }
  }
  return result;
}
