import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import runPlumb from "../engine/plumb.js";
import { parsePlayscript } from "../engine/playscript.js";
import {
  MockModelClient,
  doneResponse,
  lastUserText,
  toolCall,
} from "../engine/model/mock.js";
import type { EngineContext, ModelClient, PlumbLayer } from "../engine/types.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
  <head><title>Widget Demo</title></head>
  <body>
    <h1>Widget Demo</h1>
    <button onclick="document.getElementById('done').textContent='Continued'">Continue</button>
    <p id="done"></p>
  </body>
</html>`;

const PLAYSCRIPT = parsePlayscript(
  `PLAYSCRIPT: Widget Checkout
Purpose: A visitor confirms the widget demo page works end to end.

 1. User    Opens the widget page.
 2. System  Displays the "Widget Demo" heading.
`,
  "widget.md",
);

describe("plumb layer pursues goals with a fresh visitor", () => {
  let artifactsDir: string;
  let previewUrl: string;

  beforeAll(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), "pb-plumb-"));
    const htmlPath = join(artifactsDir, "widget.html");
    await writeFile(htmlPath, FIXTURE_HTML, "utf8");
    previewUrl = pathToFileURL(htmlPath).href;
  });

  afterAll(async () => {
    await rm(artifactsDir, { recursive: true, force: true });
  });

  function makeCtx(model: ModelClient, goals?: string[]): EngineContext {
    return {
      previewUrl,
      config: {
        project: "test",
        playscripts: { widget: { route: "/", ...(goals ? { goals } : {}) } },
        agent: { layers: ["plumb"], max_steps: 15, screenshot_every_step: false },
      },
      configDir: artifactsDir,
      playscriptsDir: artifactsDir,
      artifactsDir,
      model,
      log: () => {},
    };
  }

  it("passes a configured goal the agent verifies on the real page", async () => {
    const goal = "Confirm the Continue button reveals the Continued note.";
    const model = new MockModelClient((req) => {
      if (req.messages.length === 1) return toolCall("click", { target: "the Continue button" });
      if (req.messages.length === 3) return toolCall("read_page", {});
      const seen = lastUserText(req).includes("Continued");
      return doneResponse(
        seen
          ? { outcome: "success", reasoning: "Clicking Continue revealed the Continued note." }
          : { outcome: "failure", reasoning: "The Continued note never appeared." },
      );
    });

    const layer = (await runPlumb(makeCtx(model, [goal]), PLAYSCRIPT)) as PlumbLayer;

    expect(layer.status).toBe("pass");
    expect(layer.goals).toHaveLength(1);
    expect(layer.goals[0]!.goal).toBe(goal);
    expect(layer.goals[0]!.status).toBe("pass");
    expect(layer.goals[0]!.reasoning).toContain("Continued note");
  }, 120_000);

  it("synthesizes a goal from the playscript purpose and fails honestly", async () => {
    let synthesizedTask = "";
    const model = new MockModelClient((req) => {
      synthesizedTask = req.messages[0]!.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      return doneResponse({ outcome: "failure", reasoning: "Could not verify the flow." });
    });

    const layer = (await runPlumb(makeCtx(model), PLAYSCRIPT)) as PlumbLayer;

    expect(layer.status).toBe("fail");
    expect(layer.goals[0]!.goal).toContain(PLAYSCRIPT.purpose);
    expect(synthesizedTask).toContain(PLAYSCRIPT.purpose);
    expect(layer.goals[0]!.status).toBe("fail");
  }, 120_000);
});
