/**
 * Plumb Bob orchestrator.
 *
 * Runs plumb → level → true sequentially against one playscript, assembles
 * and validates the run report, and exits 0 on pass / 1 on fail or veto.
 *
 * The foundation ships before the layers: engine/plumb.ts, engine/level.ts,
 * engine/true.ts, and engine/model/anthropic.ts are owned by other agents.
 * When a layer module (or any model) is absent, that layer reports "skipped"
 * and the run still produces a valid report — the engine degrades, it never
 * breaks.
 *
 * Layer module contract: default-export a LayerRunner (see types.ts).
 * Model module contract: engine/model/anthropic.ts default-exports
 *   (opts?: { apiKey?: string }) => ModelClient | Promise<ModelClient>;
 * a MOCK_MODEL_MODULE default-exports () => ModelClient | Promise<ModelClient>.
 */

import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { loadPlayscripts } from "./playscript.js";
import { buildReport, validateReport, writeReport } from "./report.js";
import type {
  EngineContext,
  LayerName,
  LayerRunner,
  LevelLayer,
  ModelClient,
  PlumbLayer,
  RunReport,
  TriggerInfo,
  TrueLayer,
} from "./types.js";

/** Programmatic entry point options (the harness calls runEngine directly). */
export interface RunEngineOptions {
  previewUrl: string;
  /** Default: plumb-bob/plumb-bob.config.json relative to cwd. */
  configPath?: string;
  /** Overrides playscripts dir resolution entirely. */
  playscriptsDir?: string;
  /** Default: plumb-bob-artifacts/ relative to cwd. */
  artifactsDir?: string;
  /** Overrides config agent.layers. */
  layers?: LayerName[];
  /** Overrides config agent.max_steps. */
  maxSteps?: number;
  /** Bypasses env-based model selection — the harness seam. */
  model?: ModelClient;
  /** Overrides env-derived trigger fields (repo/pr/sha). */
  trigger?: Partial<Pick<TriggerInfo, "repo" | "pr" | "sha">>;
  log?: (msg: string) => void;
}

export interface RunEngineResult {
  report: RunReport;
  reportPath: string;
  /** 0 on pass, 1 on fail or veto — mirror this to the process exit code. */
  exitCode: number;
}

/**
 * Run the full verification pipeline once and persist the report.
 * Throws (rather than reporting) on setup problems: missing preview URL,
 * bad config, malformed or missing playscript.
 */
export async function runEngine(opts: RunEngineOptions): Promise<RunEngineResult> {
  const log = opts.log ?? ((msg: string) => console.log(`[plumb-bob] ${msg}`));
  if (!opts.previewUrl) {
    throw new Error("previewUrl is required (set PREVIEW_URL)");
  }
  const startedAt = new Date().toISOString();

  const { config, configDir, playscriptsDir } = loadConfig(
    opts.configPath ?? "plumb-bob/plumb-bob.config.json",
    opts.playscriptsDir,
  );
  if (opts.maxSteps !== undefined) config.agent.max_steps = opts.maxSteps;
  const enabled = opts.layers ?? config.agent.layers;

  const declared = Object.keys(config.playscripts);
  if (declared.length === 0) {
    throw new Error("config declares no playscripts — nothing to verify");
  }
  // v1 constraint: the report schema's level layer is singular, so we execute
  // only the first declared playscript and say so out loud.
  if (declared.length > 1) {
    log(
      `v1 executes only the first declared playscript ("${declared[0]}"); ` +
        `also declared (not run): ${declared.slice(1).join(", ")}`,
    );
  }
  const flow = declared[0]!;
  const available = await loadPlayscripts(playscriptsDir);
  const playscript = available.find(
    (p) => p.file === `${flow}.md` || p.file === `${flow}.playscript.md`,
  );
  if (!playscript) {
    throw new Error(
      `declared playscript "${flow}" not found in ${playscriptsDir} ` +
        `(looked for ${flow}.md and ${flow}.playscript.md)`,
    );
  }
  for (const warning of playscript.warnings) log(warning);

  const artifactsDir = resolve(opts.artifactsDir ?? "plumb-bob-artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const model = opts.model ?? (await resolveModel(log));
  const ctx: EngineContext | null = model
    ? {
        previewUrl: opts.previewUrl,
        config,
        configDir,
        playscriptsDir,
        artifactsDir,
        model,
        log,
      }
    : null;

  const runLayer = async <T extends PlumbLayer | LevelLayer | TrueLayer>(
    layer: LayerName,
    skipped: T,
  ): Promise<T> => {
    if (!enabled.includes(layer)) {
      log(`${layer}: skipped (not enabled for this run)`);
      return skipped;
    }
    if (!ctx) {
      log(`${layer}: skipped (no model available — set ANTHROPIC_API_KEY or MOCK_MODEL_MODULE)`);
      return skipped;
    }
    const mod = await importOptional(`./${layer}.js`);
    if (!mod) {
      log(`${layer}: skipped (engine/${layer}.ts not present)`);
      return skipped;
    }
    const runner = mod.default;
    if (typeof runner !== "function") {
      throw new Error(`engine/${layer}.ts must default-export a LayerRunner`);
    }
    log(`${layer}: running`);
    return (await (runner as LayerRunner)(ctx, playscript)) as T;
  };

  const plumb = await runLayer<PlumbLayer>("plumb", { status: "skipped", goals: [] });
  const level = await runLayer<LevelLayer>("level", {
    status: "skipped",
    playscript: playscript.file,
    steps: [],
  });
  const trueLayer = await runLayer<TrueLayer>("true", { status: "skipped", scores: [] });

  const trigger: TriggerInfo = {
    repo: opts.trigger?.repo ?? process.env.GITHUB_REPOSITORY ?? "local",
    pr: opts.trigger?.pr ?? prNumberFromEnv(),
    sha: opts.trigger?.sha ?? process.env.GITHUB_SHA ?? "dev",
    preview_url: opts.previewUrl,
  };

  const report = buildReport({
    project: config.project,
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    plumb,
    level,
    true: trueLayer,
  });
  validateReport(report);
  const reportPath = await writeReport(report, artifactsDir);
  log(`report written to ${reportPath}`);

  return { report, reportPath, exitCode: report.result === "pass" ? 0 : 1 };
}

/**
 * Pick the model client for this run: a real Anthropic client when
 * ANTHROPIC_API_KEY is set, else the MOCK_MODEL_MODULE factory (the harness
 * seam), else none — in which case every layer is skipped.
 */
async function resolveModel(log: (msg: string) => void): Promise<ModelClient | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    const mod = await importOptional("./model/anthropic.js");
    if (!mod) {
      log("ANTHROPIC_API_KEY is set but engine/model/anthropic.ts is not present; running without a model");
      return null;
    }
    const factory = mod.default as (opts?: { apiKey?: string }) => ModelClient | Promise<ModelClient>;
    return factory({ apiKey });
  }
  const mockSpec = process.env.MOCK_MODEL_MODULE;
  if (mockSpec) {
    // The mock was explicitly requested — a missing module here is an error,
    // not a degradation.
    const spec =
      mockSpec.startsWith(".") || isAbsolute(mockSpec)
        ? pathToFileURL(resolve(mockSpec)).href
        : mockSpec;
    const mod = (await import(spec)) as { default?: unknown };
    if (typeof mod.default !== "function") {
      throw new Error(`MOCK_MODEL_MODULE ${mockSpec} must default-export a ModelClient factory`);
    }
    return (mod.default as () => ModelClient | Promise<ModelClient>)();
  }
  return null;
}

/**
 * Import a sibling module that may legitimately not exist yet (layer and
 * model modules are owned by other agents). Only "module not found" for that
 * module maps to null; any other failure — including the module's own broken
 * imports throwing — propagates.
 */
async function importOptional(spec: string): Promise<{ default?: unknown } | null> {
  try {
    return (await import(spec)) as { default?: unknown };
  } catch (err) {
    if (isMissingModule(err, spec)) return null;
    throw err;
  }
}

function isMissingModule(err: unknown, spec: string): boolean {
  if (!(err instanceof Error)) return false;
  const notFound =
    (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" ||
    /cannot find (module|package)|failed to (load|resolve)/i.test(err.message);
  const moduleName = spec.replace(/^\.\//, "").replace(/\.js$/, "");
  return notFound && err.message.includes(moduleName);
}

function prNumberFromEnv(): number | null {
  const explicit = process.env.PR_NUMBER ?? process.env.GITHUB_PR_NUMBER;
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
  const refMatch = process.env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//);
  return refMatch ? Number(refMatch[1]) : null;
}

function summarize(report: RunReport): string {
  const { plumb, level, true: trueLayer } = report.layers;
  const lines = [
    `plumb-bob ${report.project} @ ${report.trigger.sha}: ${report.result.toUpperCase()}`,
    `  plumb: ${plumb.status} (${plumb.goals.length} goals)`,
    `  level: ${level.status} (${level.steps.length} steps, ${level.divergences?.length ?? 0} divergences) [${level.playscript}]`,
    `  true:  ${trueLayer.status} (${trueLayer.scores.length} scores, ${trueLayer.vetoes?.length ?? 0} vetoes)`,
  ];
  return lines.join("\n");
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), "true");
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const previewUrl = flags.get("preview-url") ?? process.env.PREVIEW_URL;
  if (!previewUrl) {
    console.error("PREVIEW_URL is required (or pass --preview-url)");
    process.exit(2);
  }
  const layersRaw = flags.get("layers") ?? process.env.LAYERS;
  const layers = layersRaw
    ? (layersRaw.split(",").map((l) => l.trim()).filter(Boolean) as LayerName[])
    : undefined;
  if (layers?.some((l) => !["plumb", "level", "true"].includes(l))) {
    console.error(`LAYERS must be a comma list drawn from plumb,level,true — got "${layersRaw}"`);
    process.exit(2);
  }
  const maxStepsRaw = flags.get("max-steps") ?? process.env.MAX_STEPS;

  const configPath = flags.get("config") ?? process.env.CONFIG_PATH;
  const playscriptsDir = flags.get("playscripts-dir") ?? process.env.PLAYSCRIPTS_DIR;
  const artifactsDir = flags.get("artifacts-dir") ?? process.env.ARTIFACTS_DIR;
  const { report, exitCode } = await runEngine({
    previewUrl,
    ...(configPath ? { configPath } : {}),
    ...(playscriptsDir ? { playscriptsDir } : {}),
    ...(artifactsDir ? { artifactsDir } : {}),
    ...(layers ? { layers } : {}),
    ...(maxStepsRaw ? { maxSteps: Number(maxStepsRaw) } : {}),
  });
  console.log(summarize(report));
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
