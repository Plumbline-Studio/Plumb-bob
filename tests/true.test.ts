import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import runTrue from "../engine/true.js";
import type {
  ContentBlock,
  EngineContext,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ParsedPlayscript,
  TrueLayer,
} from "../engine/types.js";

/** Minimal scripted model: returns one canned text block, records requests. */
class MockModelClient implements ModelClient {
  requests: ModelRequest[] = [];
  constructor(private readonly text: string) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    return { content: [{ type: "text", text: this.text }], stopReason: "end_turn" };
  }
}

const playscript: ParsedPlayscript = {
  file: "onboarding.md",
  name: "New User Onboarding",
  purpose: "A new visitor completes onboarding without coercion.",
  steps: [
    { n: 1, actor: "User", rawActor: "User", action: "Opens preview URL.", hardFail: false, isVeto: false },
    {
      n: 2,
      actor: "System",
      rawActor: "System",
      action: "Paywall is dismissible and **never** blocks continuation — integrity veto.",
      hardFail: false,
      isVeto: true,
    },
  ],
  warnings: [],
};

let workDir: string;
let logs: string[];

function makeCtx(model: ModelClient): EngineContext {
  return {
    previewUrl: "https://preview.example.com",
    config: {
      project: "owt",
      playscripts: { onboarding: { route: "/" } },
      agent: { layers: ["true"], max_steps: 60, screenshot_every_step: false },
    },
    configDir: join(workDir, "config"),
    playscriptsDir: join(workDir, "config"),
    artifactsDir: join(workDir, "artifacts"),
    model,
    log: (msg) => logs.push(msg),
  };
}

function userText(model: MockModelClient): string {
  const content = model.requests[0]!.messages[0]!.content;
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pb-true-"));
  await mkdir(join(workDir, "config"), { recursive: true });
  await mkdir(join(workDir, "artifacts"), { recursive: true });
  logs = [];
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("true layer JSON extraction robustness", () => {
  it("extracts JSON from messy prose, clamps out-of-range scores, drops malformed entries", async () => {
    const messy = [
      "Sure! Here is my principled analysis of the change.",
      "```json",
      JSON.stringify({
        scores: [
          { heuristic: "Capability over dependency", score: 2, citation: "H2", rationale: "Export feature makes the user's data theirs." },
          { heuristic: "Horizon", score: 99, citation: "H5", rationale: "Built on boring tech." },
          { heuristic: "", score: 1, citation: "H1" },
          { heuristic: "Craft", score: "sloppy", citation: "H9" },
        ],
        vetoes: [],
      }),
      "```",
      "Hope that helps! {not: json}",
    ].join("\n");
    const model = new MockModelClient(messy);

    const layer = (await runTrue(makeCtx(model), playscript)) as TrueLayer;

    expect(layer.status).toBe("pass");
    expect(layer.vetoes).toBeUndefined();
    expect(layer.scores).toEqual([
      { heuristic: "Capability over dependency", score: 2, citation: "H2", rationale: "Export feature makes the user's data theirs." },
      { heuristic: "Horizon", score: 3, citation: "H5", rationale: "Built on boring tech." },
    ]);
    const logText = logs.join("\n");
    expect(logText).toContain("clamped score 99 to 3");
    expect(logText).toContain("dropped malformed score entry");
  });

  it("vetoes when the model reports a veto, dropping evidence-free entries", async () => {
    const model = new MockModelClient(
      JSON.stringify({
        scores: [{ heuristic: "Earned trust", score: -2, citation: "H6" }],
        vetoes: [
          { veto: "Dark patterns (V1)", evidence: "Cancel link is opacity 0 in the diff." },
          { veto: "Dependency loops (V2)" },
        ],
      }),
    );

    const layer = (await runTrue(makeCtx(model), playscript)) as TrueLayer;

    expect(layer.status).toBe("veto");
    expect(layer.vetoes).toEqual([
      { veto: "Dark patterns (V1)", evidence: "Cancel link is opacity 0 in the diff." },
    ]);
    expect(logs.join("\n")).toContain("dropped malformed veto entry");
  });

  it("reports pass with no scores when the response has no JSON at all", async () => {
    const model = new MockModelClient("I cannot produce a structured assessment right now.");
    const layer = (await runTrue(makeCtx(model), playscript)) as TrueLayer;
    expect(layer).toEqual({ status: "pass", scores: [] });
    expect(logs.join("\n")).toContain("no parseable JSON");
  });

  it("skips when the context carries no model", async () => {
    const ctx = { ...makeCtx(new MockModelClient("{}")), model: undefined as unknown as ModelClient };
    const layer = (await runTrue(ctx, playscript)) as TrueLayer;
    expect(layer).toEqual({ status: "skipped", scores: [] });
  });
});

describe("true layer prompt assembly", () => {
  it("carries the principles corpus, scoring protocol, playscript veto callout, and diff section", async () => {
    const model = new MockModelClient('{"scores":[],"vetoes":[]}');
    await runTrue(makeCtx(model), playscript);

    const req = model.requests[0]!;
    // System prompt embeds the scoring protocol's rules in spirit.
    expect(req.system).toContain("overlay may ADD heuristics or vetoes; it may never remove");
    expect(req.system).toContain("Score only heuristics the change plausibly touches");
    expect(req.system).toContain("cite its ID (H1-H9, V1-V4");
    expect(req.system).toContain("integers from -2 to +3");
    expect(req.system).toContain("Vetoes are for evidence, not vibes");
    expect(req.system).toContain('{"scores":[{"heuristic"');

    const text = userText(model);
    // The full principles-core corpus is read from the engine checkout.
    expect(text).toContain("decision-heuristics.md");
    expect(text).toContain("Capability over dependency");
    expect(text).toContain("tool-maker-philosophy.md");
    // No overlay present in this consumer dir.
    expect(text).toContain("None present");
    // Diff section exists even when git cannot produce one (honest note).
    expect(text).toContain("## PR diff");
    // Playscript with veto step called out.
    expect(text).toContain("PLAYSCRIPT: New User Onboarding");
    expect(text).toContain("[INTEGRITY VETO STEP]");
    expect(text).toContain("Step 2:");
  });

  it("includes the observed-during-run section built from ctx.evidence", async () => {
    const model = new MockModelClient('{"scores":[],"vetoes":[]}');
    const ctx = makeCtx(model);
    ctx.evidence = [
      {
        n: 1,
        actor: "User",
        action: "Opens preview URL.",
        status: "pass",
        note: "Landed on the catalog.",
        textExcerpt: "Lantern Classic $29.00 Lantern Pro $49.00",
      },
      { n: 2, actor: "System", action: "Paywall is dismissible.", status: "divergence" },
    ];
    await runTrue(ctx, playscript);

    const text = userText(model);
    expect(text).toContain("## Observed during run");
    expect(text).toContain("step 1 [User] Opens preview URL. → pass — Landed on the catalog.");
    expect(text).toContain("page text: Lantern Classic $29.00 Lantern Pro $49.00");
    expect(text).toContain("step 2 [System] Paywall is dismissible. → divergence");
    // The system prompt names run evidence as a citable input.
    expect(model.requests[0]!.system).toContain("observed step evidence");
  });

  it("degrades to an honest observed-during-run note when no evidence was recorded", async () => {
    const model = new MockModelClient('{"scores":[],"vetoes":[]}');
    await runTrue(makeCtx(model), playscript);
    const text = userText(model);
    expect(text).toContain("## Observed during run");
    expect(text).toContain("No step evidence available");
  });

  it("includes the consumer overlay with its add-only framing, and attaches screenshots", async () => {
    await writeFile(
      join(workDir, "config", "principles-overlay.md"),
      "## Overlay\nH10: Offline-first — the tool must work on a job site.\n",
    );
    await mkdir(join(workDir, "artifacts", "shots"), { recursive: true });
    await writeFile(join(workDir, "artifacts", "shots", "01-welcome.png"), Buffer.from([0x89, 0x50]));

    const model = new MockModelClient('{"scores":[],"vetoes":[]}');
    await runTrue(makeCtx(model), playscript);

    const text = userText(model);
    expect(text).toContain("Offline-first");
    expect(text).toContain("This overlay ADDS heuristics or vetoes");
    expect(text).toContain("never removes or weakens core ones");
    expect(text).toMatch(/shots[/\\]01-welcome\.png/);

    const images = model.requests[0]!.messages[0]!.content.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
  });
});
