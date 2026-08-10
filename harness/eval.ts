/**
 * Plumb Bob eval harness runner (npm run harness).
 *
 * For each fixture variant: serve the fixture locally, run the REAL engine
 * against it, and compare the produced report's structural outcome to the
 * variant's golden. Two tiers share this runner:
 *
 *   mock (default)  — deterministic scripted policies drive the engine
 *                     through the ModelClient seam; zero API cost; any
 *                     golden mismatch exits 1.
 *   live            — PLUMB_BOB_EVAL_TIER=live + ANTHROPIC_API_KEY; the real
 *                     model runs each variant N times (PLUMB_BOB_EVAL_RUNS,
 *                     default 3), measuring accuracy (golden match rate) and
 *                     consistency (same structural outcome across repeats —
 *                     agentic flakiness is a first-class metric).
 *
 * Every produced report is re-read from disk and validated against
 * schema/run.schema.json — the harness doubles as the report contract's
 * regression suite, so a schema break fails the run in either tier.
 *
 * Outputs: harness/out/eval-report.json and harness/out/eval-report.md.
 * Usage: npm run harness [-- --only <variant>]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runEngine } from "../engine/run.js";
import { validateReport } from "../engine/report.js";
import type { ModelClient, RunReport } from "../engine/types.js";
import { serveFixture } from "./server.js";
import type { PolicyFn } from "./policies/common.js";
import { makePolicy as greenPolicy } from "./policies/site-green.js";
import { makePolicy as brokenPolicy } from "./policies/site-broken.js";
import { makePolicy as divergedPolicy } from "./policies/site-diverged.js";
import { makePolicy as vetoPolicy } from "./policies/site-veto.js";

const HARNESS_DIR = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = join(HARNESS_DIR, "out");

// Factories, not instances: policies carry run-scoped evidence, so every
// engine run gets a fresh one.
const VARIANTS: { name: string; makePolicy: () => PolicyFn }[] = [
  { name: "site-green", makePolicy: greenPolicy },
  { name: "site-broken", makePolicy: brokenPolicy },
  { name: "site-diverged", makePolicy: divergedPolicy },
  { name: "site-veto", makePolicy: vetoPolicy },
];

/** The structural fields goldens pin down — prose varies, structure must not. */
interface StructuralOutcome {
  result: string;
  plumb_status: string;
  level_status: string;
  failed_steps: number[];
  diverged_steps: number[];
  vetoes_present: boolean;
  /** Screenshots the report actually references (plumb goals + level steps). */
  screenshot_count: number;
}

interface Golden extends Omit<StructuralOutcome, "vetoes_present" | "screenshot_count"> {
  vetoes_expected: boolean;
  /** Floor, not exact: shot counts may legitimately grow, never vanish. */
  min_screenshots: number;
}

interface RunRecord {
  run: number;
  wall_ms: number;
  schema_valid: boolean;
  matches_golden: boolean;
  outcome?: StructuralOutcome;
  mismatches: string[];
  error?: string;
}

interface VariantRecord {
  variant: string;
  golden: Golden;
  runs: RunRecord[];
  accuracy: number;
  consistency: number;
}

function structuralOutcome(report: RunReport): StructuralOutcome {
  return {
    result: report.result,
    plumb_status: report.layers.plumb.status,
    level_status: report.layers.level.status,
    failed_steps: report.layers.level.steps.filter((s) => s.status === "fail").map((s) => s.n),
    diverged_steps: report.layers.level.steps.filter((s) => s.status === "divergence").map((s) => s.n),
    vetoes_present: (report.layers.true.vetoes?.length ?? 0) > 0,
    screenshot_count:
      report.layers.plumb.goals.reduce((sum, g) => sum + (g.screenshots?.length ?? 0), 0) +
      report.layers.level.steps.filter((s) => s.screenshot !== undefined).length,
  };
}

function compare(golden: Golden, got: StructuralOutcome): string[] {
  const diffs: string[] = [];
  const check = (field: string, want: unknown, have: unknown): void => {
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      diffs.push(`${field}: expected ${JSON.stringify(want)}, got ${JSON.stringify(have)}`);
    }
  };
  check("result", golden.result, got.result);
  check("plumb_status", golden.plumb_status, got.plumb_status);
  check("level_status", golden.level_status, got.level_status);
  check("failed_steps", [...golden.failed_steps].sort((a, b) => a - b), [...got.failed_steps].sort((a, b) => a - b));
  check("diverged_steps", [...golden.diverged_steps].sort((a, b) => a - b), [...got.diverged_steps].sort((a, b) => a - b));
  check("vetoes", golden.vetoes_expected, got.vetoes_present);
  if (got.screenshot_count < golden.min_screenshots) {
    diffs.push(`screenshots: expected at least ${golden.min_screenshots}, got ${got.screenshot_count}`);
  }
  return diffs;
}

/**
 * Wrap a policy in the other agent's MockModelClient when it has landed;
 * otherwise a minimal local stand-in with the same (req, {turn}) contract.
 * The import is dynamic so the harness typechecks and runs before
 * engine/model/mock.ts exists.
 */
async function mockClientFor(policy: PolicyFn): Promise<{ client: ModelClient; source: string }> {
  const spec = new URL("../engine/model/mock.js", import.meta.url).href;
  try {
    const mod = (await import(spec)) as { MockModelClient?: new (p: PolicyFn) => ModelClient };
    if (typeof mod.MockModelClient === "function") {
      return { client: new mod.MockModelClient(policy), source: "engine/model/mock.ts" };
    }
  } catch {
    // mock.ts not landed yet — fall through to the local stand-in.
  }
  let turn = 0;
  return {
    client: { complete: async (req) => policy(req, { turn: turn++ }) },
    source: "harness-local stand-in (engine/model/mock.ts not found)",
  };
}

async function loadGolden(variant: string): Promise<Golden> {
  const raw = await readFile(join(HARNESS_DIR, "goldens", `${variant}.json`), "utf8");
  return JSON.parse(raw) as Golden;
}

async function runVariant(
  variant: { name: string; makePolicy: () => PolicyFn },
  tier: "mock" | "live",
  runs: number,
): Promise<VariantRecord> {
  const golden = await loadGolden(variant.name);
  const fixtureDir = join(HARNESS_DIR, "fixtures", variant.name);
  const server = await serveFixture(fixtureDir);
  const records: RunRecord[] = [];
  try {
    for (let i = 1; i <= runs; i++) {
      const started = Date.now();
      const record: RunRecord = {
        run: i,
        wall_ms: 0,
        schema_valid: false,
        matches_golden: false,
        mismatches: [],
      };
      try {
        const modelOpt =
          tier === "mock" ? { model: (await mockClientFor(variant.makePolicy())).client } : {};
        const { reportPath } = await runEngine({
          previewUrl: server.url,
          configPath: join(fixtureDir, "plumb-bob", "plumb-bob.config.json"),
          artifactsDir: join(OUT_DIR, variant.name, `${tier}-run-${i}`),
          trigger: { repo: "plumb-bob-harness", pr: null, sha: `eval-${variant.name}` },
          log: (msg) => console.log(`  [${variant.name}#${i}] ${msg}`),
          ...modelOpt,
        });
        // Validate what actually landed on disk, not just the in-memory object:
        // the file is the contract downstream consumers parse.
        const persisted: unknown = JSON.parse(await readFile(reportPath, "utf8"));
        validateReport(persisted);
        record.schema_valid = true;
        record.outcome = structuralOutcome(persisted);
        record.mismatches = compare(golden, record.outcome);
        record.matches_golden = record.mismatches.length === 0;
      } catch (err) {
        record.error = err instanceof Error ? err.message : String(err);
      }
      record.wall_ms = Date.now() - started;
      records.push(record);
      console.log(
        `  [${variant.name}#${i}] ${record.matches_golden ? "MATCH" : "MISMATCH"}` +
          (record.error ? ` (error: ${record.error})` : "") +
          (record.mismatches.length > 0 ? ` (${record.mismatches.join("; ")})` : "") +
          ` in ${record.wall_ms}ms`,
      );
    }
  } finally {
    await server.close();
  }
  const accuracy = records.filter((r) => r.matches_golden).length / records.length;
  // Consistency: share of runs agreeing with the most common structural
  // outcome — 1.0 means the agent is repeatable, right or wrong.
  const groups = new Map<string, number>();
  for (const r of records) {
    const key = r.outcome ? JSON.stringify(r.outcome) : `error:${r.error ?? "unknown"}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const consistency = Math.max(...groups.values()) / records.length;
  return { variant: variant.name, golden, runs: records, accuracy, consistency };
}

function markdownReport(
  tier: string,
  runsPerVariant: number,
  variants: VariantRecord[],
  wallMs: number,
): string {
  const lines = [
    `# Plumb Bob eval report`,
    ``,
    `- tier: **${tier}**  |  runs/variant: ${runsPerVariant}  |  wall time: ${(wallMs / 1000).toFixed(1)}s`,
    `- generated: ${new Date().toISOString()}`,
    ``,
    `| variant | accuracy | consistency | schema valid | verdict | notes |`,
    `|---|---|---|---|---|---|`,
  ];
  for (const v of variants) {
    const schemaOk = v.runs.every((r) => r.schema_valid);
    const verdict = v.accuracy === 1 && schemaOk ? "PASS" : "FAIL";
    const notes = v.runs
      .flatMap((r) => (r.error ? [`run ${r.run}: ${r.error}`] : r.mismatches.map((m) => `run ${r.run}: ${m}`)))
      .join("<br>");
    lines.push(
      `| ${v.variant} | ${(v.accuracy * 100).toFixed(0)}% | ${(v.consistency * 100).toFixed(0)}% | ${schemaOk ? "yes" : "NO"} | ${verdict} | ${notes} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : undefined;
  const tier = process.env.PLUMB_BOB_EVAL_TIER === "live" ? "live" : "mock";
  if (tier === "live" && !process.env.ANTHROPIC_API_KEY) {
    console.error("live tier requires ANTHROPIC_API_KEY");
    process.exit(2);
  }
  const runsPerVariant = tier === "live" ? Number(process.env.PLUMB_BOB_EVAL_RUNS) || 3 : 1;

  const selected = VARIANTS.filter((v) => !only || v.name === only);
  if (selected.length === 0) {
    console.error(`--only ${only}: no such variant (have: ${VARIANTS.map((v) => v.name).join(", ")})`);
    process.exit(2);
  }

  console.log(`plumb-bob harness — tier ${tier}, ${runsPerVariant} run(s) per variant`);
  const startedAt = Date.now();
  const results: VariantRecord[] = [];
  for (const variant of selected) {
    console.log(`${variant.name}:`);
    results.push(await runVariant(variant, tier, runsPerVariant));
  }
  const wallMs = Date.now() - startedAt;

  const anyMismatch = results.some((v) => v.accuracy < 1);
  const anySchemaFail = results.some((v) => v.runs.some((r) => !r.schema_valid && !r.error));
  const anyError = results.some((v) => v.runs.some((r) => r.error !== undefined));
  const accuracyOverall =
    results.reduce((sum, v) => sum + v.accuracy, 0) / results.length;

  await mkdir(OUT_DIR, { recursive: true });
  const jsonReport = {
    tier,
    runs_per_variant: runsPerVariant,
    generated_at: new Date().toISOString(),
    wall_ms: wallMs,
    accuracy_overall: accuracyOverall,
    all_schema_valid: !anySchemaFail,
    variants: results,
  };
  await writeFile(join(OUT_DIR, "eval-report.json"), `${JSON.stringify(jsonReport, null, 2)}\n`, "utf8");
  await writeFile(join(OUT_DIR, "eval-report.md"), markdownReport(tier, runsPerVariant, results, wallMs), "utf8");

  console.log(`\naccuracy ${(accuracyOverall * 100).toFixed(0)}% — report in harness/out/eval-report.{json,md}`);
  // Mock tier is deterministic: any mismatch is a machinery regression.
  // Live tier tolerates model variance but never a schema or setup failure.
  const failed = (tier === "mock" && anyMismatch) || anySchemaFail || anyError;
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(2);
});
