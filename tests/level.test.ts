import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import runLevel from "../engine/level.js";
import { parsePlayscript } from "../engine/playscript.js";
import {
  MockModelClient,
  doneResponse,
  lastUserText,
  taskText,
  toolCall,
} from "../engine/model/mock.js";
import type { EngineContext, LevelLayer, ModelClient } from "../engine/types.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
  <head><title>Widget Demo</title></head>
  <body>
    <h1>Widget Demo</h1>
    <button onclick="document.getElementById('done').textContent='Continued'">Continue</button>
    <p id="done"></p>
  </body>
</html>`;

describe("level layer executes playscripts against a static page", () => {
  let artifactsDir: string;
  let previewUrl: string;

  beforeAll(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), "pb-level-"));
    const htmlPath = join(artifactsDir, "widget.html");
    await writeFile(htmlPath, FIXTURE_HTML, "utf8");
    previewUrl = pathToFileURL(htmlPath).href;
  });

  afterAll(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  function makeCtx(model: ModelClient, screenshotEveryStep: boolean): EngineContext {
    return {
      previewUrl,
      config: {
        project: "test",
        playscripts: { widget: { route: "" } },
        agent: { layers: ["level"], max_steps: 30, screenshot_every_step: screenshotEveryStep },
      },
      configDir: artifactsDir,
      playscriptsDir: artifactsDir,
      artifactsDir,
      model,
      log: () => {},
    };
  }

  it("runs a 4-step script: one deliberate divergence yields the Matthies question", async () => {
    const playscript = parsePlayscript(
      `PLAYSCRIPT: Widget Checkout
Purpose: A visitor confirms the widget demo page works end to end.

 1. User    Opens the widget page.
 2. System  Displays the "Widget Demo" heading.
 3. User    Clicks the "Continue" button.
 4. System  Shows the confirmation banner.
`,
      "widget.md",
    );

    const model = new MockModelClient((req) => {
      const task = taskText(req);
      if (task.includes("Opens the widget page")) {
        return doneResponse({ outcome: "success", reasoning: "Already on the widget page." });
      }
      if (task.includes('Displays the "Widget Demo" heading')) {
        // Honest verification: read the REAL page before answering.
        if (req.messages.length === 1) return toolCall("read_page", {});
        const seen = lastUserText(req).includes("Widget Demo");
        return doneResponse(
          seen
            ? { outcome: "success", reasoning: 'The heading "Widget Demo" is visible.' }
            : { outcome: "failure", reasoning: "The heading is missing." },
        );
      }
      if (task.includes('Clicks the "Continue" button')) {
        if (req.messages.length === 1) return toolCall("click", { target: 'the "Continue" button' });
        return doneResponse({ outcome: "success", reasoning: "Clicked Continue." });
      }
      if (task.includes("Shows the confirmation banner")) {
        return doneResponse({
          outcome: "failure",
          reasoning: "No confirmation banner appeared; the page shows a plain Continued note instead.",
        });
      }
      return doneResponse({ outcome: "failure", reasoning: `Unexpected task: ${task}` });
    });

    const layer = (await runLevel(makeCtx(model, true), playscript)) as LevelLayer;

    expect(layer.playscript).toBe("widget.md");
    expect(layer.steps.map((s) => s.status)).toEqual(["pass", "pass", "pass", "divergence"]);
    expect(layer.status).toBe("divergence");

    expect(layer.divergences).toHaveLength(1);
    expect(layer.divergences![0]!.step).toBe(4);
    expect(layer.divergences![0]!.question).toMatch(
      /^Step 4: expected "Shows the confirmation banner\." — observed .*Continued note.*\. Script wrong, or build wrong\?$/,
    );

    // screenshot_every_step: every executed step carries evidence on disk.
    for (const step of layer.steps) {
      expect(step.screenshot).toBe(join("screenshots", `level-step-${step.n}-after.png`));
      expect(existsSync(join(artifactsDir, step.screenshot!))).toBe(true);
    }
  }, 120_000);

  it("fails the layer when a `= FAIL` step diverges, and skips Bob steps in v1", async () => {
    const playscript = parsePlayscript(
      `PLAYSCRIPT: Paywall Guard
Purpose: The soft paywall must stay dismissible, never blocking.

 1. User    Opens the widget page.
 2. System  Allows continuation past the paywall. (Hard-block here = FAIL)
 3. Bob     Verifies PostHog paywall events fired correctly.
`,
      "widget.md",
    );

    const model = new MockModelClient((req) => {
      const task = taskText(req);
      if (task.includes("Opens the widget page")) {
        return doneResponse({ outcome: "success", reasoning: "On the widget page." });
      }
      return doneResponse({
        outcome: "failure",
        reasoning: "The page hard-blocks: no way to continue past the paywall.",
      });
    });

    const layer = (await runLevel(makeCtx(model, false), playscript)) as LevelLayer;

    expect(layer.steps.map((s) => s.status)).toEqual(["pass", "fail", "skipped"]);
    expect(layer.status).toBe("fail");
    expect(layer.steps[1]!.note).toContain("hard-blocks");
    expect(layer.steps[2]!.note).toBe("integration not configured (v1)");
    expect(layer.divergences).toBeUndefined();
  }, 120_000);

  it("hands the integrity-veto step the accumulated run log and a preamble that permits revisiting", async () => {
    const playscript = parsePlayscript(
      `PLAYSCRIPT: Integrity Audit
Purpose: The widget demo must never smuggle in a hidden charge.

 1. User    Opens the widget page.
 2. User    Clicks the "Continue" button.
 3. System  (Integrity veto) Verifies the page **never** shows a hidden charge.
`,
      "widget.md",
    );

    let vetoTask = "";
    let vetoPreamble = "";
    const model = new MockModelClient((req) => {
      const task = taskText(req);
      if (task.includes("Integrity check")) {
        vetoTask = task;
        vetoPreamble = req.system;
        return doneResponse({ outcome: "success", reasoning: "No hidden charge anywhere in the run." });
      }
      if (task.includes("Opens the widget page")) {
        return doneResponse({ outcome: "success", reasoning: "Already on the widget page." });
      }
      if (task.includes('Clicks the "Continue" button')) {
        if (req.messages.length === 1) return toolCall("click", { target: 'the "Continue" button' });
        return doneResponse({ outcome: "success", reasoning: "Clicked Continue." });
      }
      return doneResponse({ outcome: "failure", reasoning: `Unexpected task: ${task}` });
    });

    const ctx = makeCtx(model, false);
    const layer = (await runLevel(ctx, playscript)) as LevelLayer;
    expect(layer.steps.map((s) => s.status)).toEqual(["pass", "pass", "pass"]);

    // The veto task carries the run log: every prior step with its outcome
    // and the page text observed at that step — the evidence a live model
    // needs to judge "was NOT observed during this run".
    expect(vetoTask).toContain("Run log");
    expect(vetoTask).toContain("[User] Opens the widget page. → pass");
    expect(vetoTask).toContain('[User] Clicks the "Continue" button. → pass');
    expect(vetoTask).toContain("page text: ");
    expect(vetoTask).toContain("Widget Demo");

    // The veto preamble permits re-reading and revisiting the flow — it is
    // not the observation-only verify preamble.
    expect(vetoPreamble).toContain("navigate back to pages this run already visited");

    // Run evidence accumulated on the shared context, excerpts bounded.
    expect(ctx.evidence).toHaveLength(3);
    expect(ctx.evidence![0]).toMatchObject({ n: 1, actor: "User", status: "pass" });
    for (const e of ctx.evidence!) {
      expect(e.textExcerpt ?? "").not.toHaveLength(0);
      expect((e.textExcerpt ?? "").length).toBeLessThanOrEqual(600);
    }
    expect(ctx.evidence![1]!.textExcerpt).toContain("Continued");
  }, 120_000);

  it("stops after a User-step failure and marks the rest skipped: not reached", async () => {
    const playscript = parsePlayscript(
      `PLAYSCRIPT: Broken Entry
Purpose: Entry into the flow must work for a fresh visitor.

 1. User    Clicks the "Missing" button.
 2. System  Shows the dashboard.
 3. User    Continues onward.
`,
      "widget.md",
    );

    const model = new MockModelClient((req) => {
      if (req.messages.length === 1) {
        // Genuinely attempt the click — the resolver fails on the real page.
        return toolCall("click", { target: 'the "Missing" button' });
      }
      const feedback = lastUserText(req);
      return doneResponse({
        outcome: feedback.includes("Action failed") ? "failure" : "success",
        reasoning: "There is no Missing button on the page; the click could not be performed.",
      });
    });

    const layer = (await runLevel(makeCtx(model, false), playscript)) as LevelLayer;

    expect(layer.steps.map((s) => s.status)).toEqual(["fail", "skipped", "skipped"]);
    expect(layer.status).toBe("fail");
    expect(layer.steps[0]!.note).toContain("no Missing button");
    expect(layer.steps[1]!.note).toBe("not reached");
    expect(layer.steps[2]!.note).toBe("not reached");
  }, 120_000);
});
