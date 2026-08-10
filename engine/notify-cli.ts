/**
 * Post-run notifier CLI — the composite action's second script step.
 *
 * Reads <ARTIFACTS_DIR>/report.json (the engine already wrote and validated
 * it), posts/updates the PR comment, optionally POSTs to the ingest endpoint,
 * then exits with the run's verdict so the check goes red on fail/veto:
 *   0  pass (divergences included — those are questions, not verdicts)
 *   1  fail or veto
 *   2  usage error (no readable report — the engine itself blew up upstream)
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { postComment, postIngest } from "./notify.js";
import type { RunReport } from "./types.js";

async function main(): Promise<void> {
  const log = (msg: string): void => console.log(`[plumb-bob] ${msg}`);
  const artifactsDir = resolve(process.env.ARTIFACTS_DIR ?? "plumb-bob-artifacts");
  const reportPath = join(artifactsDir, "report.json");

  let report: RunReport;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8")) as RunReport;
  } catch (err) {
    console.error(
      `[plumb-bob] cannot read run report at ${reportPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }
  if (typeof report.result !== "string" || typeof report.run_id !== "string") {
    console.error(`[plumb-bob] ${reportPath} is not a run report (missing result/run_id)`);
    process.exit(2);
  }

  await postComment(report, { log });

  const ingestUrl = process.env.INGEST_URL;
  if (ingestUrl) {
    await postIngest(report, artifactsDir, { ingestUrl, ingestKey: process.env.INGEST_KEY, log });
  }

  log(`run ${report.run_id}: ${report.result}`);
  process.exit(report.result === "pass" ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`[plumb-bob] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
