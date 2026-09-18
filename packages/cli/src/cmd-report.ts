import { readFileSync, writeFileSync } from "node:fs";
import { renderEvalReport, type EvalReportData } from "./report.ts";

/** `report <eval.json>` — static HTML rendering of `eval --json` output. */
export async function cmdReport(o: { input: string; out?: string }): Promise<number> {
  let data: EvalReportData;
  try {
    data = JSON.parse(readFileSync(o.input, "utf8")) as EvalReportData;
  } catch (e) {
    console.error(
      `report: can't read eval JSON at ${o.input}: ${e instanceof Error ? e.message : e}`,
    );
    return 2;
  }
  const html = renderEvalReport(data);
  if (o.out) {
    writeFileSync(o.out, html);
    console.error(`wrote ${o.out}`);
  } else {
    console.log(html);
  }
  return 0;
}
