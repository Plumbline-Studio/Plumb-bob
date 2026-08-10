#!/usr/bin/env node
/**
 * Append one provenance-stamped record per eval run to the history log.
 *
 * Why this exists: accuracy and consistency are the engine's KPIs, but a
 * single run only tells you today. Variance over time is the number that
 * actually matters for an agentic system — and it can only be computed from
 * history that was captured at the time. CI artifacts expire; this doesn't.
 *
 * Why provenance is mandatory: without model id + engine sha + fixture sha,
 * a dip in accuracy is unattributable — you cannot tell whether the model
 * drifted, a prompt changed, or a fixture got harder. That distinction is
 * the entire diagnostic value of the series.
 *
 * Usage: node harness/append-history.mjs [outPath]
 *   outPath defaults to evals/history.jsonl relative to cwd.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPORT_PATH = join(HARNESS_DIR, "out", "eval-report.json");
const outPath = process.argv[2] ?? "evals/history.jsonl";

/** Mean of a numeric list; NaN-safe for the empty case (no variants ran). */
function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

const raw = await readFile(REPORT_PATH, "utf8").catch((err) => {
  // Fail loudly: a silent skip here would leave gaps in the series that look
  // identical to "the eval never ran".
  throw new Error(`no eval report at ${REPORT_PATH} — did the harness run? (${err.message})`);
});
const report = JSON.parse(raw);

const variants = {};
for (const v of report.variants ?? []) {
  const schemaOk = v.runs.every((r) => r.schema_valid);
  variants[v.variant] = {
    accuracy: v.accuracy,
    consistency: v.consistency,
    schema_valid: schemaOk,
    verdict: v.accuracy === 1 && schemaOk ? "pass" : "fail",
    // First mismatch only — the full detail lives in the run artifact; this
    // line is for charting and triage, not forensics.
    first_mismatch:
      v.runs.flatMap((r) => (r.error ? [`run ${r.run}: ${r.error}`] : r.mismatches.map((m) => `run ${r.run}: ${m}`)))[0] ??
      null,
  };
}

const record = {
  ts: report.generated_at ?? new Date().toISOString(),
  tier: report.tier,
  // Provenance — the fields that make a dip attributable.
  model: process.env.PLUMB_BOB_MODEL ?? "claude-sonnet-4-5",
  engine_sha: process.env.GITHUB_SHA ?? "local",
  repo: process.env.GITHUB_REPOSITORY ?? "local",
  ci_run_id: process.env.GITHUB_RUN_ID ?? null,
  // The KPIs.
  runs_per_variant: report.runs_per_variant,
  accuracy_overall: report.accuracy_overall,
  consistency_overall: mean((report.variants ?? []).map((v) => v.consistency)),
  all_schema_valid: report.all_schema_valid,
  wall_ms: report.wall_ms,
  variant_count: (report.variants ?? []).length,
  variants,
};

await mkdir(dirname(outPath), { recursive: true });
await appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8");

console.log(
  `eval history += ${record.tier} run — accuracy ${(record.accuracy_overall * 100).toFixed(0)}%, ` +
    `consistency ${(record.consistency_overall * 100).toFixed(0)}%, model ${record.model} → ${outPath}`,
);
