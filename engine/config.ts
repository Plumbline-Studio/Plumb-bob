// Configuration loading for a Plumb Bob run.
//
// Inputs arrive two ways:
//   1. As a GitHub Action — action.yml maps `with:` inputs to env vars.
//   2. Locally — the same env vars, optionally overridden by CLI flags, so a
//      developer (or Kyle) can drive a run by hand: `tsx engine/run.ts --preview-url ...`.
//
// Nothing product-specific is baked in here. The consumer repo's
// plumb-bob.config.json supplies project slug, playscripts, and integration
// toggles; everything else is an Action input.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

export type LayerName = "plumb" | "level" | "true";

export interface ConsumerConfig {
  project: string;
  playscripts: Record<string, { route?: string }>;
  integrations?: {
    supabase?: { persistence_checks?: boolean };
    posthog?: { project_ref?: string };
    revenuecat?: { sandbox?: boolean };
  };
  agent?: {
    layers?: LayerName[];
    max_steps?: number;
    screenshot_every_step?: boolean;
  };
}

export interface Config {
  previewUrl: string;
  anthropicApiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  layers: LayerName[];
  maxSteps: number;
  screenshotEveryStep: boolean;
  dryRun: boolean;

  // Where the consumer config + playscripts live in the checked-out repo.
  configPath: string;
  playscriptDir: string;
  consumer: ConsumerConfig;

  // Where principles-core lives inside THIS engine (bundled with the action).
  principlesDir: string;
  // Optional consumer overlay that ADDS heuristics/vetoes.
  overlayPath: string | null;

  // Trigger metadata.
  repo: string;
  pr: number | null;
  sha: string;
  baseRef: string; // for the True-layer diff

  // Output locations.
  outputDir: string;
  screenshotDir: string;

  // Optional integrations (read-only) + Console ingest.
  supabaseUrl: string | null;
  supabaseServiceKey: string | null;
  posthogApiKey: string | null;
  ingestUrl: string | null;
  ingestKey: string | null;
  githubToken: string | null;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

// CLI flag wins over env var wins over default.
function pick(argv: string[], flagName: string, envName: string, dflt = ""): string {
  return flag(argv, flagName) ?? process.env[envName] ?? dflt;
}

function detectPrNumber(): number | null {
  const fromEnv = process.env.PR_NUMBER;
  if (fromEnv) return Number(fromEnv) || null;
  // GitHub pull_request events carry the number in the event payload.
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const event = JSON.parse(readFileSync(eventPath, "utf8"));
      if (event?.pull_request?.number) return Number(event.pull_request.number);
    } catch {
      // fall through
    }
  }
  return null;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const engineDir = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
  const repoRoot = resolve(engineDir, "..");

  const configPath = resolve(
    workspace,
    pick(argv, "config", "CONFIG_PATH", "plumb-bob/plumb-bob.config.json"),
  );

  if (!existsSync(configPath)) {
    throw new Error(
      `Consumer config not found at ${configPath}. ` +
        `Expected plumb-bob/plumb-bob.config.json (see INSTALL.md).`,
    );
  }
  const consumer = JSON.parse(readFileSync(configPath, "utf8")) as ConsumerConfig;

  const playscriptDir = resolve(dirname(configPath), "playscripts");
  const overlayCandidate = resolve(dirname(configPath), "principles-overlay.md");

  const layersRaw = pick(argv, "layers", "LAYERS", "");
  const layers = (
    layersRaw
      ? (layersRaw.split(",").map((s) => s.trim()) as LayerName[])
      : consumer.agent?.layers ?? ["plumb", "level", "true"]
  ).filter((l): l is LayerName => l === "plumb" || l === "level" || l === "true");

  const outputDir = resolve(workspace, pick(argv, "output-dir", "OUTPUT_DIR", "plumb-bob-report"));

  return {
    previewUrl: pick(argv, "preview-url", "PREVIEW_URL"),
    anthropicApiKey: pick(argv, "anthropic-api-key", "ANTHROPIC_API_KEY"),
    model: pick(argv, "model", "PLUMB_BOB_MODEL", "claude-opus-4-8"),
    effort: (pick(argv, "effort", "PLUMB_BOB_EFFORT", "high") as Config["effort"]),
    layers,
    maxSteps: Number(pick(argv, "max-steps", "MAX_STEPS", String(consumer.agent?.max_steps ?? 60))),
    screenshotEveryStep: consumer.agent?.screenshot_every_step ?? true,
    dryRun: has(argv, "dry-run") || process.env.DRY_RUN === "true",

    configPath,
    playscriptDir,
    consumer,

    principlesDir: resolve(repoRoot, "principles-core"),
    overlayPath: existsSync(overlayCandidate) ? overlayCandidate : null,

    repo: pick(argv, "repo", "GITHUB_REPOSITORY", consumer.project),
    pr: detectPrNumber(),
    sha: pick(argv, "sha", "GITHUB_SHA", ""),
    baseRef: pick(argv, "base-ref", "BASE_REF", "origin/main"),

    outputDir,
    screenshotDir: resolve(outputDir, "screenshots"),

    supabaseUrl: pick(argv, "supabase-url", "SUPABASE_URL") || null,
    supabaseServiceKey: pick(argv, "supabase-service-key", "SUPABASE_SERVICE_KEY") || null,
    posthogApiKey: pick(argv, "posthog-api-key", "POSTHOG_API_KEY") || null,
    ingestUrl: pick(argv, "ingest-url", "INGEST_URL") || null,
    ingestKey: pick(argv, "ingest-key", "INGEST_KEY") || null,
    githubToken: pick(argv, "github-token", "GITHUB_TOKEN") || null,
  };
}
