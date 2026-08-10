import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateReport } from "../engine/report.js";
import { runEngine } from "../engine/run.js";

const EXAMPLE_CONFIG = fileURLToPath(
  new URL("../examples/consumer-repo/plumb-bob/plumb-bob.config.json", import.meta.url),
);

// The layer modules (engine/plumb.ts etc.) are owned by other agents and must
// not exist in this repo yet — this suite proves the foundation runs alone.
const MODEL_ENV = ["ANTHROPIC_API_KEY", "MOCK_MODEL_MODULE"] as const;
const CI_ENV = ["GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF", "PR_NUMBER", "GITHUB_PR_NUMBER"] as const;

describe("runEngine with no layer modules present", () => {
  let artifactsDir: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), "pb-artifacts-"));
    for (const key of [...MODEL_ENV, ...CI_ENV]) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("yields a valid all-skipped report and exit code 0", async () => {
    const logs: string[] = [];
    const { report, reportPath, exitCode } = await runEngine({
      previewUrl: "http://localhost:3000",
      configPath: EXAMPLE_CONFIG,
      artifactsDir,
      log: (msg) => logs.push(msg),
    });

    expect(() => validateReport(report)).not.toThrow();
    expect(report.result).toBe("pass");
    expect(exitCode).toBe(0);

    expect(report.layers.plumb).toEqual({ status: "skipped", goals: [] });
    expect(report.layers.level).toEqual({
      status: "skipped",
      playscript: "onboarding.md",
      steps: [],
    });
    expect(report.layers.true).toEqual({ status: "skipped", scores: [] });

    expect(report.project).toBe("owt");
    expect(report.trigger).toEqual({
      repo: "local",
      pr: null,
      sha: "dev",
      preview_url: "http://localhost:3000",
    });

    expect(existsSync(reportPath)).toBe(true);
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual(report);

    // Every skip is announced — silent degradation would hide missing layers.
    for (const layer of ["plumb", "level", "true"]) {
      expect(logs.some((l) => l.startsWith(`${layer}: skipped`))).toBe(true);
    }
  });

  it("honors a layers override and env-derived trigger info", async () => {
    process.env.GITHUB_REPOSITORY = "plumbline/owt";
    process.env.GITHUB_SHA = "deadbeef";
    process.env.GITHUB_REF = "refs/pull/123/merge";

    const { report } = await runEngine({
      previewUrl: "https://preview.example.com",
      configPath: EXAMPLE_CONFIG,
      artifactsDir,
      layers: ["plumb"],
      log: () => {},
    });

    expect(() => validateReport(report)).not.toThrow();
    expect(report.trigger).toEqual({
      repo: "plumbline/owt",
      pr: 123,
      sha: "deadbeef",
      preview_url: "https://preview.example.com",
    });
  });

  it("throws when previewUrl is missing", async () => {
    await expect(
      runEngine({ previewUrl: "", configPath: EXAMPLE_CONFIG, artifactsDir, log: () => {} }),
    ).rejects.toThrow(/previewUrl is required/);
  });
});
