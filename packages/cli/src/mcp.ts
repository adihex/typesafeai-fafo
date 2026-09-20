import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { loadRepoEnv, makeAsker, resolveFiles, scanConflicts } from "./mcp-tools.ts";

const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version as string;

/**
 * `fafo-resolve mcp` — expose the resolver to agents over stdio MCP.
 * Jev still never writes code; agents get the same gates the CLI has.
 */

const SCAN_TOOL = {
  name: "fafo_scan",
  title: "Scan merge conflicts",
  description:
    "List files with unresolved git merge-conflict markers and how many conflict hunks each has. Read-only; needs no API key. Use to size up a merge before resolving.",
  annotations: {
    title: "Scan merge conflicts",
    readOnlyHint: true,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      cwd: {
        type: "string",
        description: "Repo or worktree root. Default: the server's working directory.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "Explicit repo-relative file list. Default: git's unmerged paths (diff-filter=U).",
      },
    },
  },
} as const;

const RESOLVE_TOOL = {
  name: "fafo_resolve",
  title: "Resolve merge conflicts",
  description:
    "Resolve git merge conflicts with TypeSafe Jev: code enumerates candidate resolutions (ours/theirs/both/union/base/drop/spliced), Jev picks and verifies, and only hunks passing confidence/coverage/verification gates are written. Escalated hunks keep their <<<<<<< markers for human or agent review — re-run fafo_scan to see what's left.",
  annotations: {
    title: "Resolve merge conflicts",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      cwd: {
        type: "string",
        description: "Repo or worktree root. Default: the server's working directory.",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description:
          "Explicit repo-relative file list. Default: git's unmerged paths (diff-filter=U).",
      },
      check: {
        type: "boolean",
        description: "Dry run — report decisions, write nothing.",
      },
      oursIntent: {
        type: "string",
        description:
          "What our side was trying to do (commit message, PR description). Improves picks.",
      },
      theirsIntent: {
        type: "string",
        description: "Same for their side.",
      },
      noDecompose: {
        type: "boolean",
        description: "Skip the per-window retry and per-line splice fallbacks.",
      },
      model: {
        type: "string",
        description: "Model override passed through to the Jev request.",
      },
    },
  },
} as const;

// Structured content alongside the text block — spec recommends both for
// machine-readable results; the text stays for clients that only read content.
const ok = (data: object) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const fail = (err: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: err instanceof Error ? err.message : String(err),
    },
  ],
  isError: true as const,
});

export async function cmdMcp(): Promise<never> {
  loadRepoEnv();
  const server = new Server(
    { name: "fafo-resolve", version: VERSION },
    { capabilities: { tools: {} } },
  );

  // Lifecycle: initialization MUST be the first interaction — refuse work
  // until the client's notifications/initialized arrives.
  let initialized = false;
  server.oninitialized = () => {
    initialized = true;
  };
  const requireInit = () => {
    if (!initialized) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "server not initialized — send initialize, then notifications/initialized",
      );
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    requireInit();
    return { tools: [SCAN_TOOL, RESOLVE_TOOL] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    requireInit();
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
    const files = Array.isArray(args.files)
      ? args.files.filter((f): f is string => typeof f === "string")
      : undefined;
    try {
      if (req.params.name === "fafo_scan") {
        return ok(scanConflicts(cwd, files));
      }
      if (req.params.name === "fafo_resolve") {
        if (!process.env.TYPESAFE_API_KEY) {
          return fail(
            "TYPESAFE_API_KEY is not set — export it or add it to the fafo repo's .env.",
          );
        }
        const res = await resolveFiles(
          {
            cwd,
            files,
            check: args.check === true,
            oursIntent: typeof args.oursIntent === "string" ? args.oursIntent : undefined,
            theirsIntent:
              typeof args.theirsIntent === "string" ? args.theirsIntent : undefined,
            decompose: args.noDecompose === true ? false : undefined,
            model: typeof args.model === "string" ? args.model : undefined,
          },
          makeAsker(),
        );
        return ok(res);
      }
      // Spec: unknown tools are protocol errors, not tool results.
      throw new McpError(
        ErrorCode.MethodNotFound,
        `unknown tool: ${req.params.name}`,
      );
    } catch (err) {
      if (err instanceof McpError) throw err;
      return fail(err);
    }
  });

  await server.connect(new StdioServerTransport());
  // stdio transport lives as long as stdin does — never resolve, or main() exits.
  return new Promise<never>(() => {});
}
