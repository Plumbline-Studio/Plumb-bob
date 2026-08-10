import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runAgentTask } from "../engine/agent-loop.js";
import { BrowserSession } from "../engine/browser/session.js";
import { createBrowserTools } from "../engine/browser/tools.js";
import {
  MockModelClient,
  doneResponse,
  lastUserText,
  toolCall,
} from "../engine/model/mock.js";
import type { BrowserTools, ImageBlock } from "../engine/types.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
  <head><title>Widget Demo</title></head>
  <body>
    <h1>Widget Demo</h1>
    <button onclick="document.getElementById('done').textContent='Continued'">Continue</button>
    <p id="done"></p>
  </body>
</html>`;

describe("runAgentTask with a scripted model and a real page", () => {
  let session: BrowserSession;
  let tools: BrowserTools;
  let artifactsDir: string;

  beforeAll(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), "pb-loop-"));
    session = new BrowserSession();
    await session.launch();
    tools = createBrowserTools(session, artifactsDir);
  }, 60_000);

  afterAll(async () => {
    await session.close();
    await rm(artifactsDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await session.freshContext();
  });

  it("lets a mock policy read, click, screenshot (seeing the image), and finish", async () => {
    await session.freshContext();
    await session.page().setContent(FIXTURE_HTML);

    let sawPageJson = false;
    let sawImageBlock = false;
    const model = new MockModelClient((req, { turn }) => {
      if (turn === 0) return toolCall("read_page", {});
      if (turn === 1) {
        // The read_page tool_result must reach the model as JSON text.
        sawPageJson = lastUserText(req).includes('"title":"Widget Demo"');
        return toolCall("click", { target: "the Continue button" });
      }
      if (turn === 2) return toolCall("screenshot", { name: "after-click" });
      // The screenshot tool_result must carry the actual image block.
      const last = req.messages[req.messages.length - 1]!;
      sawImageBlock = last.content.some(
        (b) =>
          b.type === "tool_result" &&
          Array.isArray(b.content) &&
          b.content.some(
            (c): c is ImageBlock =>
              c.type === "image" && c.source.media_type === "image/png" && c.source.data.length > 0,
          ),
      );
      return doneResponse({ outcome: "success", reasoning: "Clicked Continue and captured evidence." });
    });

    const result = await runAgentTask({
      model,
      tools,
      task: "Click Continue and gather evidence.",
      systemPreamble: "You are a QA agent.",
      screenshotPrefix: "loop",
      artifactsDir,
    });

    expect(result.outcome).toBe("success");
    expect(result.reasoning).toBe("Clicked Continue and captured evidence.");
    expect(sawPageJson).toBe(true);
    expect(sawImageBlock).toBe(true);
    expect(result.screenshots).toEqual([join("screenshots", "loop-0-after-click.png")]);
    expect(existsSync(join(artifactsDir, "screenshots", "loop-0-after-click.png"))).toBe(true);
    // The click really happened on the real page.
    expect(await session.page().locator("#done").textContent()).toBe("Continued");
    expect(result.transcriptSummary).toContain("click(the Continue button) ok");
  }, 60_000);

  it("feeds a failed browser action back as an honest tool_result, never a crash", async () => {
    await session.freshContext();
    await session.page().setContent(FIXTURE_HTML);

    let failureFedBack = "";
    const model = new MockModelClient((req, { turn }) => {
      if (turn === 0) return toolCall("click", { target: "the Launch Rocket button" });
      failureFedBack = lastUserText(req);
      return doneResponse({
        outcome: "failure",
        reasoning: "The Launch Rocket button does not exist on this page.",
      });
    });

    const result = await runAgentTask({
      model,
      tools,
      task: "Click the Launch Rocket button.",
      systemPreamble: "You are a QA agent.",
      screenshotPrefix: "loop-fail",
      artifactsDir,
    });

    expect(result.outcome).toBe("failure");
    expect(failureFedBack).toContain("Action failed:");
    expect(failureFedBack).toContain("the Launch Rocket button");
    expect(result.transcriptSummary).toContain("FAILED");
  }, 60_000);

  it("fails honestly when maxTurns is exceeded without finish", async () => {
    await session.freshContext();
    await session.page().setContent(FIXTURE_HTML);

    const model = new MockModelClient(() => toolCall("read_page", {}));
    const result = await runAgentTask({
      model,
      tools,
      task: "Loop forever.",
      systemPreamble: "You are a QA agent.",
      maxTurns: 3,
      screenshotPrefix: "loop-max",
      artifactsDir,
    });

    expect(result.outcome).toBe("failure");
    expect(result.reasoning).toMatch(/did not finish within 3 turns/);
    expect(result.transcriptSummary).toContain("read_page");
  }, 60_000);
});
