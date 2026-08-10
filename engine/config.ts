/**
 * Consumer configuration loader.
 *
 * loadConfig reads plumb-bob.config.json, validates it (fail fast, named
 * fields in errors), applies agent defaults, and resolves the playscripts
 * directory so nothing downstream ever guesses paths.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentConfig, LayerName, PlayscriptConfig, PlumbBobConfig } from "./types.js";

const LAYER_NAMES: readonly LayerName[] = ["plumb", "level", "true"];

const AGENT_DEFAULTS: AgentConfig = {
  layers: ["plumb", "level", "true"],
  max_steps: 60,
  screenshot_every_step: true,
};

/** A validated config plus the resolved paths every consumer of it needs. */
export interface LoadedConfig {
  config: PlumbBobConfig;
  /** Absolute directory containing the config file. */
  configDir: string;
  /** Absolute, existing directory the playscripts live in. */
  playscriptsDir: string;
}

/**
 * Load and validate the consumer config at `path`.
 *
 * playscriptsDir resolution order (first that exists wins):
 *   1. `playscriptsDirOverride` (from PLAYSCRIPTS_DIR / --playscripts-dir) —
 *      when given it must exist;
 *   2. "playscripts" next to the config (the standard plumb-bob/ layout);
 *   3. "plumb-bob/playscripts" under the config dir (config at repo root);
 *   4. "playscripts" at the repo root (repo root = parent of a plumb-bob/
 *      config dir, else the config dir itself).
 *
 * Throws with the offending path/field on any miss.
 */
export function loadConfig(path: string, playscriptsDirOverride?: string): LoadedConfig {
  const absPath = resolve(path);
  if (!existsSync(absPath)) {
    throw new Error(`plumb-bob config not found at ${absPath} (set CONFIG_PATH or --config)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absPath, "utf8"));
  } catch (err) {
    throw new Error(`${absPath}: invalid JSON: ${(err as Error).message}`);
  }
  const config = validateConfig(parsed, absPath);

  const configDir = dirname(absPath);
  const repoRoot = basename(configDir) === "plumb-bob" ? dirname(configDir) : configDir;
  const candidates = playscriptsDirOverride
    ? [resolve(playscriptsDirOverride)]
    : [
        join(configDir, "playscripts"),
        join(configDir, "plumb-bob", "playscripts"),
        join(repoRoot, "playscripts"),
      ];
  const playscriptsDir = candidates.find((c) => existsSync(c));
  if (!playscriptsDir) {
    throw new Error(`no playscripts directory found; looked in: ${candidates.join(", ")}`);
  }

  return { config, configDir, playscriptsDir };
}

function validateConfig(raw: unknown, path: string): PlumbBobConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: config must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.project !== "string" || obj.project.length === 0) {
    throw new Error(`${path}: "project" is required and must be a non-empty string`);
  }

  const playscripts: Record<string, PlayscriptConfig> = {};
  if (obj.playscripts !== undefined) {
    if (typeof obj.playscripts !== "object" || obj.playscripts === null || Array.isArray(obj.playscripts)) {
      throw new Error(`${path}: "playscripts" must be an object mapping flow name to settings`);
    }
    for (const [key, value] of Object.entries(obj.playscripts as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path}: playscripts.${key} must be an object`);
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.route !== "string") {
        throw new Error(`${path}: playscripts.${key}.route is required and must be a string`);
      }
      if (
        entry.goals !== undefined &&
        (!Array.isArray(entry.goals) || entry.goals.some((g) => typeof g !== "string"))
      ) {
        throw new Error(`${path}: playscripts.${key}.goals must be an array of strings`);
      }
      playscripts[key] = {
        route: entry.route,
        ...(entry.goals !== undefined ? { goals: entry.goals as string[] } : {}),
      };
    }
  }

  const agentIn = (obj.agent ?? {}) as Record<string, unknown>;
  if (typeof agentIn !== "object" || agentIn === null || Array.isArray(agentIn)) {
    throw new Error(`${path}: "agent" must be an object`);
  }
  let layers = AGENT_DEFAULTS.layers;
  if (agentIn.layers !== undefined) {
    if (
      !Array.isArray(agentIn.layers) ||
      agentIn.layers.some((l) => !LAYER_NAMES.includes(l as LayerName))
    ) {
      throw new Error(`${path}: agent.layers must be an array drawn from ${LAYER_NAMES.join(", ")}`);
    }
    layers = agentIn.layers as LayerName[];
  }
  if (agentIn.max_steps !== undefined && (typeof agentIn.max_steps !== "number" || agentIn.max_steps < 1)) {
    throw new Error(`${path}: agent.max_steps must be a positive number`);
  }
  if (agentIn.screenshot_every_step !== undefined && typeof agentIn.screenshot_every_step !== "boolean") {
    throw new Error(`${path}: agent.screenshot_every_step must be a boolean`);
  }
  const agent: AgentConfig = {
    layers: [...layers],
    max_steps: (agentIn.max_steps as number | undefined) ?? AGENT_DEFAULTS.max_steps,
    screenshot_every_step:
      (agentIn.screenshot_every_step as boolean | undefined) ?? AGENT_DEFAULTS.screenshot_every_step,
  };

  const config: PlumbBobConfig = { project: obj.project, playscripts, agent };
  if (obj.integrations !== undefined) {
    if (typeof obj.integrations !== "object" || obj.integrations === null || Array.isArray(obj.integrations)) {
      throw new Error(`${path}: "integrations" must be an object`);
    }
    config.integrations = obj.integrations as NonNullable<PlumbBobConfig["integrations"]>;
  }
  return config;
}
