import type { ResolveOptions } from "@fafo/core";

/** Raw `fafo.*` configuration values, already pulled out of vscode. */
export interface FafoSettings {
  apiKey?: string;
  minConfidence?: number;
  minCoverage?: number;
  minVerify?: number;
  noVerify?: boolean;
  decompose?: boolean;
  maxWindows?: number;
  contextLines?: number;
  model?: string;
}

/** Map settings onto core's ResolveOptions; empty model means "SDK default". */
export function toResolveOptions(s: FafoSettings): ResolveOptions {
  const model = s.model?.trim();
  return {
    minConfidence: s.minConfidence,
    minCoverage: s.minCoverage,
    minVerify: s.minVerify,
    noVerify: s.noVerify,
    decompose: s.decompose,
    maxWindows: s.maxWindows,
    contextLines: s.contextLines,
    model: model ? model : undefined,
  };
}

/**
 * Env first, then the `fafo.apiKey` setting. Blank/whitespace counts as unset.
 * The key is only ever held in memory — never written to SecretStorage or disk.
 */
export function resolveApiKey(
  env: string | undefined,
  setting: string | undefined,
): string | undefined {
  const e = env?.trim();
  if (e) return e;
  const s = setting?.trim();
  if (s) return s;
  return undefined;
}
