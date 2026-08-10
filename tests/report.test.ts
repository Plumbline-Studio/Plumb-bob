import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReport, validateReport, writeReport, type ReportParts } from "../engine/report.js";
import type { LevelLayer, PlumbLayer, TrueLayer } from "../engine/types.js";

const passingPlumb: PlumbLayer = {
  status: "pass",
  goals: [{ goal: "new visitor completes onboarding", status: "pass", screenshots: ["shots/01.png"] }],
};
const failingPlumb: PlumbLayer = {
  status: "fail",
  goals: [{ goal: "new visitor completes onboarding", status: "fail", reasoning: "paywall hard-blocked" }],
};
const passingLevel: LevelLayer = {
  status: "pass",
  playscript: "onboarding.md",
  steps: [{ n: 1, actor: "User", action: "Opens preview URL.", status: "pass" }],
};
const failingLevel: LevelLayer = {
  status: "fail",
  playscript: "onboarding.md",
  steps: [{ n: 11, actor: "System", action: "Allows continuation.", status: "fail", note: "hard block" }],
};
const divergentLevel: LevelLayer = {
  status: "divergence",
  playscript: "onboarding.md",
  steps: [{ n: 4, actor: "System", action: "Each screen renders.", status: "divergence" }],
  divergences: [{ step: 4, question: "Script says 4 screens, build shows 3 — script wrong or build wrong?" }],
};
const passingTrue: TrueLayer = {
  status: "pass",
  scores: [{ heuristic: "boring tech", score: 2, citation: "decision-heuristics.md#boring" }],
};
const vetoTrue: TrueLayer = {
  status: "veto",
  scores: [],
  vetoes: [{ veto: "fake data presented as real", evidence: "seeded testimonials render on prod path" }],
};

function parts(overrides: Partial<ReportParts> = {}): ReportParts {
  return {
    project: "owt",
    trigger: { repo: "plumbline/owt", pr: 42, sha: "abc123", preview_url: "https://preview.example.com" },
    startedAt: "2026-08-10T12:00:00.000Z",
    finishedAt: "2026-08-10T12:05:00.000Z",
    plumb: passingPlumb,
    level: passingLevel,
    true: passingTrue,
    ...overrides,
  };
}

describe("buildReport result computation", () => {
  it("passes when all layers pass", () => {
    expect(buildReport(parts()).result).toBe("pass");
  });

  it("veto outranks everything, even concurrent failures", () => {
    const report = buildReport(parts({ true: vetoTrue, plumb: failingPlumb, level: failingLevel }));
    expect(report.result).toBe("veto");
  });

  it("fails when plumb fails", () => {
    expect(buildReport(parts({ plumb: failingPlumb })).result).toBe("fail");
  });

  it("fails when level fails", () => {
    expect(buildReport(parts({ level: failingLevel })).result).toBe("fail");
  });

  it("divergence alone never fails the run", () => {
    expect(buildReport(parts({ level: divergentLevel })).result).toBe("pass");
  });

  it("all-skipped layers pass (nothing failed, nothing vetoed)", () => {
    const report = buildReport(
      parts({
        plumb: { status: "skipped", goals: [] },
        level: { status: "skipped", playscript: "onboarding.md", steps: [] },
        true: { status: "skipped", scores: [] },
      }),
    );
    expect(report.result).toBe("pass");
  });

  it("mints a uuid run_id and stamps schema_version 1.0", () => {
    const report = buildReport(parts());
    expect(report.schema_version).toBe("1.0");
    expect(report.run_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("validateReport", () => {
  it("accepts a hand-built valid report, including skipped level steps", () => {
    const report = buildReport(
      parts({
        level: {
          status: "pass",
          playscript: "onboarding.md",
          steps: [
            { n: 1, actor: "User", action: "Opens preview URL.", status: "pass" },
            { n: 7, actor: "Bob", action: "Verifies profile row.", status: "skipped", note: "supabase not configured" },
          ],
        },
        true: vetoTrue,
      }),
    );
    expect(() => validateReport(report)).not.toThrow();
  });

  it("rejects a report missing a required field, naming the problem", () => {
    const report = buildReport(parts()) as unknown as Record<string, unknown>;
    delete report.run_id;
    expect(() => validateReport(report)).toThrow(/schema validation.*run_id/);
  });

  it("rejects an out-of-enum layer status", () => {
    const report = buildReport(parts());
    (report.layers.plumb as { status: string }).status = "maybe";
    expect(() => validateReport(report)).toThrow(/schema validation/);
  });

  it("rejects an out-of-range true-layer score", () => {
    const report = buildReport(
      parts({ true: { status: "pass", scores: [{ heuristic: "h", score: 9, citation: "c" }] } }),
    );
    expect(() => validateReport(report)).toThrow(/schema validation/);
  });
});

describe("writeReport", () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the artifacts dir and writes report.json", async () => {
    dir = join(await mkdtemp(join(tmpdir(), "pb-report-")), "artifacts");
    const report = buildReport(parts());
    const path = await writeReport(report, dir);
    expect(path).toBe(join(dir, "report.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(report);
  });
});
