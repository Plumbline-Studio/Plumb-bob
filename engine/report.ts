/**
 * Run report assembly, validation, and persistence.
 *
 * buildReport computes the overall result (veto > fail > pass; a divergence
 * alone never fails — that is the Matthies contract), validateReport checks
 * the finished object against schema/run.schema.json with ajv, and
 * writeReport lands it in the artifacts directory.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";

// NodeNext sees ajv-formats' CJS namespace type; at runtime the default
// import is the plugin function itself.
const addFormats = addFormatsImport as unknown as (ajv: Ajv) => unknown;
import type { LevelLayer, PlumbLayer, RunReport, TriggerInfo, TrueLayer } from "./types.js";

/** Everything buildReport needs; run_id is minted here unless supplied. */
export interface ReportParts {
  project: string;
  trigger: TriggerInfo;
  startedAt: string;
  finishedAt: string;
  plumb: PlumbLayer;
  level: LevelLayer;
  true: TrueLayer;
  runId?: string;
}

/**
 * Assemble a RunReport from layer results. Result precedence: a True-layer
 * veto wins over everything; a plumb or level "fail" fails the run; anything
 * else — including level "divergence" and skipped layers — passes, because
 * divergences are questions for humans, not verdicts.
 */
export function buildReport(parts: ReportParts): RunReport {
  const vetoed = parts.true.status === "veto";
  const failed = parts.plumb.status === "fail" || parts.level.status === "fail";
  return {
    schema_version: "1.0",
    run_id: parts.runId ?? randomUUID(),
    project: parts.project,
    trigger: parts.trigger,
    started_at: parts.startedAt,
    finished_at: parts.finishedAt,
    result: vetoed ? "veto" : failed ? "fail" : "pass",
    layers: { plumb: parts.plumb, level: parts.level, true: parts.true },
  };
}

const SCHEMA_URL = new URL("../schema/run.schema.json", import.meta.url);
let compiledSchema: ValidateFunction | null = null;

/**
 * Validate a report against schema/run.schema.json. Throws listing every
 * violation (path + message) — a report that fails its own schema must never
 * reach a consumer.
 */
export function validateReport(report: unknown): asserts report is RunReport {
  if (!compiledSchema) {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    compiledSchema = ajv.compile(JSON.parse(readFileSync(SCHEMA_URL, "utf8")) as object);
  }
  if (!compiledSchema(report)) {
    const details = (compiledSchema.errors ?? [])
      .map((e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`)
      .join("; ");
    throw new Error(`run report failed schema validation: ${details}`);
  }
}

/**
 * Write the report as pretty-printed JSON to `<artifactsDir>/report.json`,
 * creating the directory if needed. Returns the absolute file path.
 */
export async function writeReport(report: RunReport, artifactsDir: string): Promise<string> {
  await mkdir(artifactsDir, { recursive: true });
  const path = join(artifactsDir, "report.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}
