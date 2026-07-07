// Report assembly + validation.
//
// run.schema.json is the contract — the Console and any notifier consume the
// JSON, never prose. So the engine validates every report against that schema
// before writing it; a schema violation is a hard error (exit non-zero), never
// a silently-shipped malformed report.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import AjvImport from "ajv";
import addFormatsImport from "ajv-formats";
// ajv / ajv-formats ship CJS with a `.default` under NodeNext interop; unwrap
// so the class is constructable regardless of how the module shape resolves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv: any = (AjvImport as any).default ?? AjvImport;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats: any = (addFormatsImport as any).default ?? addFormatsImport;
import type { Config } from "./config.js";
import type { RunReport, Result, PlumbLayer, LevelLayer, TrueLayer } from "./types.js";

function schemaPath(): string {
  const engineDir = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
  return resolve(engineDir, "..", "schema", "run.schema.json");
}

export function computeResult(plumb: PlumbLayer, level: LevelLayer, trueLayer: TrueLayer): Result {
  // A veto blocks merge regardless of functional green (integrity is supreme).
  if (trueLayer.status === "veto") return "veto";
  // Functional or procedural failure fails the check. Divergence does NOT.
  if (plumb.status === "fail" || level.status === "fail") return "fail";
  return "pass";
}

export interface AssembleInput {
  startedAt: string;
  finishedAt: string;
  plumb: PlumbLayer;
  level: LevelLayer;
  trueLayer: TrueLayer;
}

export function assembleReport(config: Config, input: AssembleInput): RunReport {
  return {
    schema_version: "1.0",
    run_id: randomUUID(),
    project: config.consumer.project,
    trigger: {
      repo: config.repo,
      pr: config.pr,
      sha: config.sha,
      preview_url: config.previewUrl,
    },
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    result: computeResult(input.plumb, input.level, input.trueLayer),
    layers: {
      plumb: input.plumb,
      level: input.level,
      true: input.trueLayer,
    },
  };
}

export function validateReport(report: RunReport): { valid: boolean; errors: string[] } {
  const schema = JSON.parse(readFileSync(schemaPath(), "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(report) as boolean;
  const errors = (validate.errors ?? []).map(
    (e: { instancePath?: string; message?: string }) => `${e.instancePath || "(root)"} ${e.message ?? ""}`.trim(),
  );
  return { valid, errors };
}

export function writeReport(config: Config, report: RunReport): string {
  mkdirSync(config.outputDir, { recursive: true });
  const path = join(config.outputDir, "run.json");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  return path;
}
