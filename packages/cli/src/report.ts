/**
 * Render `eval --json` output into a single self-contained HTML report.
 * Pure — no IO, no deps. Everything optional: the report degrades to
 * whatever fields the producer emitted.
 */

export interface EvalHunkRow {
  action?: string;
  candidate?: string;
  reason?: string;
  error?: string;
  conf?: number;
  cov?: number;
  ours?: string[];
  theirs?: string[];
  base?: string[] | null;
  resolution?: string[] | null;
  windows?: Array<{
    index?: number;
    picked?: string;
    conf?: number;
    cov?: number;
    action?: string;
    reason?: string;
  }>;
  wholeHunkReason?: string;
}

export interface EvalFileRow {
  merge?: string;
  path?: string;
  applied?: number;
  escalated?: number;
  verdict?: string;
  resolvedTruth?: string | null;
  resolvedOurs?: string | null;
  hunks?: EvalHunkRow[];
  [k: string]: unknown;
}

export interface EvalReportData {
  summary?: {
    entries?: number;
    escalated?: number;
    resolvedByUs?: number;
    matchedTruth?: number;
    matchRate?: number | null;
    coverageNote?: string;
    [k: string]: unknown;
  };
  rows?: EvalFileRow[];
  [k: string]: unknown;
}

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmt = (n: number | undefined): string =>
  n === undefined ? "—" : n.toFixed(2);

const lines = (v: string[] | string | null | undefined): string =>
  Array.isArray(v) ? v.join("\n") : typeof v === "string" ? v : "";

function verdictClass(verdict: string | undefined): string {
  const v = (verdict ?? "").toLowerCase();
  if (v === "match") return "ok";
  if (v.startsWith("differs") || v.includes("error")) return "bad";
  if (v.startsWith("escalated")) return "warn";
  return "info";
}

function col(title: string, text: string, cls = ""): string {
  return `<div class="col ${cls}"><h4>${esc(title)}</h4><pre>${esc(text)}</pre></div>`;
}

function hunkHtml(h: EvalHunkRow, i: number): string {
  const applied = h.action === "apply";
  const bits: string[] = [`hunk ${i}`];
  bits.push(
    applied
      ? `<span class="pill apply">apply ${esc(h.candidate ?? "?")}</span>`
      : `<span class="pill escalate">escalate${h.reason ? " — " + esc(h.reason) : ""}</span>`,
  );
  if (h.conf !== undefined || h.cov !== undefined) {
    bits.push(`<span class="sig">conf ${fmt(h.conf)} · cov ${fmt(h.cov)}</span>`);
  }
  if (h.error) bits.push(`<span class="err">${esc(h.error)}</span>`);
  if (h.wholeHunkReason) {
    bits.push(`<span class="sig">whole-hunk: ${esc(h.wholeHunkReason)} → decomposed</span>`);
  }

  const cols: string[] = [];
  const ours = lines(h.ours);
  const theirs = lines(h.theirs);
  const base = lines(h.base);
  const res = lines(h.resolution);
  if (ours || theirs || res) {
    if (base) cols.push(col("BASE", base, "base"));
    cols.push(col("OURS", ours));
    cols.push(col("THEIRS", theirs));
    cols.push(
      applied
        ? col("RESOLUTION", res, "res")
        : col("RESOLUTION", "(markers kept — hunk still conflicted)", "res pending"),
    );
  }

  let windows = "";
  if (h.windows?.length) {
    const rows = h.windows
      .map(
        (w) =>
          `<tr><td>${w.index ?? ""}</td><td>${esc(w.picked ?? "—")}</td>` +
          `<td>${fmt(w.conf)}</td><td>${fmt(w.cov)}</td>` +
          `<td class="${w.action === "apply" ? "ok-t" : "warn-t"}">${esc(w.action ?? "")}` +
          `${w.reason ? " — " + esc(w.reason) : ""}</td></tr>`,
      )
      .join("");
    windows =
      `<details class="windows"><summary>per-window trace (${h.windows.length})</summary>` +
      `<table><thead><tr><th>win</th><th>pick</th><th>conf</th><th>cov</th><th>action</th></tr></thead>` +
      `<tbody>${rows}</tbody></table></details>`;
  }

  return `<div class="hunk"><div class="hunk-head">${bits.join(" ")}</div>` +
    (cols.length ? `<div class="cols">${cols.join("")}</div>` : "") +
    windows + `</div>`;
}

function rowHtml(r: EvalFileRow): string {
  const vc = verdictClass(r.verdict);
  const counts = [
    r.applied !== undefined ? `${r.applied} applied` : null,
    r.escalated !== undefined ? `${r.escalated} escalated` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const hunks = (r.hunks ?? []).map(hunkHtml).join("");

  let compare = "";
  if (r.resolvedTruth != null || r.resolvedOurs != null) {
    compare =
      `<details class="compare"><summary>full-file: fafo vs human resolution</summary>` +
      `<div class="cols">` +
      col("FAFO RESOLVED", r.resolvedOurs ?? "(nothing applied)") +
      col("HUMAN TRUTH", r.resolvedTruth ?? "(file deleted in truth)") +
      `</div></details>`;
  }

  return (
    `<section class="row ${vc}">` +
    `<h2><span class="badge ${vc}">${esc(r.verdict ?? "?")}</span> ` +
    `<span class="path">${esc(r.path ?? "(unknown)")}</span>` +
    (r.merge ? ` <span class="merge">@${esc(r.merge)}</span>` : "") +
    (counts ? ` <span class="counts">${esc(counts)}</span>` : "") +
    `</h2>${hunks}${compare}</section>`
  );
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font: 14px/1.45 -apple-system, "SF Mono", "Segoe UI", system-ui, sans-serif;
       margin: 0; padding: 2rem clamp(1rem, 4vw, 3rem); background: #0d1117; color: #e6edf3; }
header { margin-bottom: 2rem; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
.sub { color: #8b949e; font-size: .85rem; }
.stats { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }
.stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px;
        padding: .6rem 1rem; min-width: 7rem; }
.stat b { display: block; font-size: 1.25rem; }
.stat span { color: #8b949e; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
.row { background: #161b22; border: 1px solid #30363d; border-left-width: 4px;
       border-radius: 8px; margin-bottom: 1.25rem; padding: .9rem 1.1rem; }
.row.ok { border-left-color: #3fb950; } .row.bad { border-left-color: #f85149; }
.row.warn { border-left-color: #d29922; } .row.info { border-left-color: #58a6ff; }
h2 { font-size: 1rem; margin: 0 0 .6rem; font-weight: 600; display: flex; flex-wrap: wrap; gap: .5rem; align-items: baseline; }
.badge { font-size: .72rem; padding: .15rem .55rem; border-radius: 999px; font-weight: 700; text-transform: uppercase; }
.badge.ok { background: #238636; } .badge.bad { background: #da3633; }
.badge.warn { background: #9e6a03; } .badge.info { background: #1f6feb; }
.path { font-family: ui-monospace, monospace; }
.merge, .counts, .sig { color: #8b949e; font-size: .8rem; font-weight: 400; }
.hunk { border-top: 1px solid #21262d; padding: .6rem 0; }
.hunk-head { font-size: .85rem; margin-bottom: .5rem; display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.pill { font-size: .72rem; padding: .1rem .5rem; border-radius: 999px; font-weight: 600; }
.pill.apply { background: #1f6feb33; color: #58a6ff; border: 1px solid #1f6feb; }
.pill.escalate { background: #d2992233; color: #d29922; border: 1px solid #d29922; }
.err { color: #f85149; font-size: .8rem; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: .6rem; }
.col h4 { margin: 0 0 .3rem; font-size: .7rem; color: #8b949e; text-transform: uppercase; letter-spacing: .05em; }
.col pre { margin: 0; padding: .6rem; background: #0d1117; border: 1px solid #21262d;
           border-radius: 6px; overflow-x: auto; font-size: .78rem; line-height: 1.5;
           font-family: ui-monospace, "SF Mono", Menlo, monospace; white-space: pre; max-height: 24rem; overflow-y: auto; }
.col.res pre { border-color: #1f6feb66; }
.col.res.pending pre { color: #d29922; font-style: italic; }
.col.base pre { color: #8b949e; }
details { margin-top: .5rem; }
summary { cursor: pointer; color: #8b949e; font-size: .8rem; }
table { border-collapse: collapse; margin-top: .4rem; font-size: .78rem; }
th, td { border: 1px solid #21262d; padding: .2rem .6rem; text-align: left; }
th { color: #8b949e; font-weight: 600; }
.ok-t { color: #3fb950; } .warn-t { color: #d29922; }
footer { color: #6e7681; font-size: .75rem; margin-top: 2rem; }
`;

export function renderEvalReport(data: EvalReportData | EvalFileRow[]): string {
  const rows = Array.isArray(data) ? data : (data.rows ?? []);
  const summary = Array.isArray(data) ? undefined : data.summary;

  const stats: Array<[string, string]> = [];
  if (summary) {
    if (summary.entries !== undefined) stats.push([String(summary.entries), "files"]);
    if (summary.resolvedByUs !== undefined) stats.push([String(summary.resolvedByUs), "resolved"]);
    if (summary.escalated !== undefined) stats.push([String(summary.escalated), "escalated"]);
    if (summary.matchedTruth !== undefined) stats.push([String(summary.matchedTruth), "matched truth"]);
    if (summary.matchRate !== undefined && summary.matchRate !== null) {
      stats.push([`${(summary.matchRate * 100).toFixed(1)}%`, "match rate"]);
    }
  } else {
    stats.push([String(rows.length), "files"]);
  }

  const statHtml = stats
    .map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fafo-resolve eval report</title><style>${CSS}</style></head>
<body><header>
<h1>fafo-resolve eval report</h1>
<div class="sub">Jev picks candidates; escalated hunks are the gate doing its job — neither right nor wrong.${summary?.coverageNote ? " " + esc(summary.coverageNote) : ""}</div>
<div class="stats">${statHtml}</div>
</header><main>
${rows.map(rowHtml).join("\n")}
</main><footer>generated by fafo-resolve report</footer></body></html>
`;
}
