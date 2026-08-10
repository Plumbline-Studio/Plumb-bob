import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../engine/config.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pb-config-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(dir: string, config: unknown): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "plumb-bob.config.json");
  await writeFile(path, JSON.stringify(config));
  return path;
}

describe("loadConfig: validation and defaults", () => {
  it("applies agent defaults when agent block is absent", async () => {
    const dir = join(root, "plumb-bob");
    const path = await writeConfig(dir, { project: "owt" });
    await mkdir(join(dir, "playscripts"), { recursive: true });

    const { config } = loadConfig(path);
    expect(config.project).toBe("owt");
    expect(config.agent).toEqual({
      layers: ["plumb", "level", "true"],
      max_steps: 60,
      screenshot_every_step: true,
    });
    expect(config.playscripts).toEqual({});
  });

  it("keeps explicit agent values and per-playscript goals", async () => {
    const dir = join(root, "plumb-bob");
    const path = await writeConfig(dir, {
      project: "owt",
      playscripts: { onboarding: { route: "/", goals: ["signs up", "sees feed"] } },
      agent: { layers: ["plumb"], max_steps: 10 },
    });
    await mkdir(join(dir, "playscripts"), { recursive: true });

    const { config } = loadConfig(path);
    expect(config.agent.layers).toEqual(["plumb"]);
    expect(config.agent.max_steps).toBe(10);
    expect(config.agent.screenshot_every_step).toBe(true);
    expect(config.playscripts.onboarding).toEqual({
      route: "/",
      goals: ["signs up", "sees feed"],
    });
  });

  it("throws when project is missing", async () => {
    const path = await writeConfig(root, { playscripts: {} });
    expect(() => loadConfig(path)).toThrow(/"project" is required/);
  });

  it("throws when a playscript entry has no route", async () => {
    const path = await writeConfig(root, { project: "x", playscripts: { onboarding: {} } });
    expect(() => loadConfig(path)).toThrow(/playscripts\.onboarding\.route/);
  });

  it("throws on unknown layer names", async () => {
    const path = await writeConfig(root, { project: "x", agent: { layers: ["plumb", "vibes"] } });
    expect(() => loadConfig(path)).toThrow(/agent\.layers/);
  });

  it("throws when the config file does not exist", () => {
    expect(() => loadConfig(join(root, "nope.json"))).toThrow(/config not found/);
  });

  it("throws on invalid JSON with the path in the message", async () => {
    const path = join(root, "plumb-bob.config.json");
    await writeFile(path, "{ not json");
    expect(() => loadConfig(path)).toThrow(/invalid JSON/);
  });
});

describe("loadConfig: playscriptsDir resolution", () => {
  it("prefers an explicit override over everything else", async () => {
    const dir = join(root, "plumb-bob");
    const path = await writeConfig(dir, { project: "x" });
    await mkdir(join(dir, "playscripts"), { recursive: true });
    const override = join(root, "elsewhere");
    await mkdir(override, { recursive: true });

    expect(loadConfig(path, override).playscriptsDir).toBe(override);
  });

  it("uses playscripts next to the config in the standard layout", async () => {
    const dir = join(root, "plumb-bob");
    const path = await writeConfig(dir, { project: "x" });
    await mkdir(join(dir, "playscripts"), { recursive: true });
    await mkdir(join(root, "playscripts"), { recursive: true });

    expect(loadConfig(path).playscriptsDir).toBe(join(dir, "playscripts"));
  });

  it("falls back to playscripts at the repo root", async () => {
    const dir = join(root, "plumb-bob");
    const path = await writeConfig(dir, { project: "x" });
    await mkdir(join(root, "playscripts"), { recursive: true });

    expect(loadConfig(path).playscriptsDir).toBe(join(root, "playscripts"));
  });

  it("supports a root-level config with plumb-bob/playscripts beside it", async () => {
    const path = await writeConfig(root, { project: "x" });
    await mkdir(join(root, "plumb-bob", "playscripts"), { recursive: true });

    expect(loadConfig(path).playscriptsDir).toBe(join(root, "plumb-bob", "playscripts"));
  });

  it("throws when no candidate directory exists", async () => {
    const dir = join(root, "plumb-bob");
    const path = await writeConfig(dir, { project: "x" });
    expect(() => loadConfig(path)).toThrow(/no playscripts directory found/);
  });

  it("throws when the override itself does not exist", async () => {
    const dir = join(root, "plumb-bob");
    const path = await writeConfig(dir, { project: "x" });
    await mkdir(join(dir, "playscripts"), { recursive: true });
    expect(() => loadConfig(path, join(root, "missing"))).toThrow(
      /no playscripts directory found/,
    );
  });
});
