// Plumb Bob orchestrator.
//
// Runs the three layers in sequence — Plumb (functional) → Level (procedural)
// → True (principled) — assembles the report, validates it against the schema
// contract, posts one PR comment, optionally ingests to the Console, and exits
// non-zero on a functional/procedural FAIL or an integrity VETO (a divergence
// never fails the run).
//
// Runnable two ways: as the composite Action (action.yml maps inputs to env),
// or locally by hand — `tsx engine/run.ts --preview-url ... --anthropic-api-key ...`,
// or `--dry-run` to exercise the plumbing with no API key or browser.

import { appendFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import type { PlumbLayer, LevelLayer, TrueLayer } from "./types.js";
import { makeClient } from "./anthropic.js";
import { PlaywrightMcp } from "./mcp.js";
import { runPlumb } from "./plumb.js";
import { runLevel } from "./level.js";
import { runTrue } from "./true.js";
import { getDiff } from "./git.js";
import { assembleReport, validateReport, writeReport } from "./report.js";
import { renderComment, postComment, ingest } from "./notify.js";

function nowIso(): string {
  return new Date().toISOString();
}

function makeLogger(): { log: (m: string) => void } {
  return { log: (m: string) => console.log(`[plumb-bob] ${m}`) };
}

function setOutput(name: string, value: string): void {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${name}=${value}\n`);
}

function writeSummary(body: string): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, body + "\n");
}

async function runLive(config: Config, log: (m: string) => void) {
  const client = makeClient(config);

  let plumb: PlumbLayer = { status: "skipped", goals: [] };
  let level: LevelLayer = { status: "skipped", playscript: "(skipped)", steps: [], divergences: [] };
  let trueLayer: TrueLayer = { status: "skipped", scores: [] };

  const needBrowser = config.layers.includes("plumb") || config.layers.includes("level");
  let mcp: PlaywrightMcp | null = null;
  if (needBrowser) {
    log("Starting Playwright MCP…");
    mcp = new PlaywrightMcp(config.outputDir, config.screenshotDir);
    await mcp.start();
  }

  try {
    if (config.layers.includes("plumb") && mcp) {
      log("Plumb (functional)…");
      plumb = await runPlumb(client, mcp, config);
      log(`Plumb: ${plumb.status} (${plumb.goals.length} goal(s)).`);
    }
    if (config.layers.includes("level") && mcp) {
      log("Level (procedural)…");
      level = await runLevel(client, mcp, config, log);
      log(`Level: ${level.status} (${level.steps.length} step(s)).`);
    }
  } finally {
    if (mcp) await mcp.close();
  }

  if (config.layers.includes("true")) {
    log("True (principled)…");
    const { diff, note } = getDiff(config.baseRef, config.sha);
    const screenshots = plumb.goals.flatMap((g) => g.screenshots ?? []);
    trueLayer = await runTrue(client, config, diff, note, screenshots);
    log(`True: ${trueLayer.status} (${trueLayer.scores.length} score(s), ${trueLayer.vetoes?.length ?? 0} veto(es)).`);
  }

  return { plumb, level, trueLayer };
}

function dryRun(): { plumb: PlumbLayer; level: LevelLayer; trueLayer: TrueLayer } {
  return {
    plumb: { status: "skipped", goals: [] },
    level: { status: "skipped", playscript: "(dry-run)", steps: [], divergences: [] },
    trueLayer: { status: "skipped", scores: [] },
  };
}

async function main() {
  const { log } = makeLogger();
  const config = loadConfig();
  const startedAt = nowIso();

  log(`project=${config.consumer.project} preview=${config.previewUrl || "(none)"} layers=${config.layers.join(",")}${config.dryRun ? " DRY-RUN" : ""}`);

  const layers = config.dryRun ? dryRun() : await runLive(config, log);
  const finishedAt = nowIso();

  const report = assembleReport(config, { startedAt, finishedAt, ...layers });

  const { valid, errors } = validateReport(report);
  if (!valid) {
    log("Report FAILED schema validation — this is a contract violation:");
    for (const e of errors) log(`  - ${e}`);
    process.exit(2);
  }

  const path = writeReport(config, report);
  log(`Report written: ${path} (result=${report.result})`);

  const comment = renderComment(report);
  writeSummary(comment);
  if (!config.dryRun) {
    await postComment(config, comment, log);
    await ingest(config, report, log);
  }

  setOutput("result", report.result);
  setOutput("report_path", path);
  setOutput("run_id", report.run_id);

  // Functional/procedural FAIL or integrity VETO fails the check.
  if (report.result === "fail" || report.result === "veto") {
    log(`Result is ${report.result} — failing the check.`);
    process.exit(1);
  }
  log("Result is pass.");
}

main().catch((err) => {
  console.error(`[plumb-bob] fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(3);
});
