import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession } from "../engine/browser/session.js";
import { createBrowserTools, resolveTarget } from "../engine/browser/tools.js";
import type { BrowserTools } from "../engine/types.js";

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
  <head><title>Widget Demo</title></head>
  <body>
    <h1>Widget Demo</h1>
    <p>Welcome to the widget demonstration page.</p>
    <button onclick="document.getElementById('done').textContent='Continued'">Continue</button>
    <p id="done"></p>
    <label>Email <input placeholder="you@example.com"></label>
    <label>Plan
      <select onchange="document.getElementById('plan').textContent=this.value">
        <option value="alpha">Alpha</option>
        <option value="beta">Beta</option>
      </select>
    </label>
    <p id="plan"></p>
    <a href="#pricing">See pricing</a>
  </body>
</html>`;

describe("browser tools against a real chromium page", () => {
  let session: BrowserSession;
  let tools: BrowserTools;
  let artifactsDir: string;

  beforeAll(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), "pb-tools-"));
    session = new BrowserSession();
    await session.launch();
    await session.freshContext();
    tools = createBrowserTools(session, artifactsDir);
    await session.page().setContent(FIXTURE_HTML);
  }, 60_000);

  afterAll(async () => {
    await session.close();
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it("resolves a human description with a role word via getByRole", async () => {
    const locator = await resolveTarget(session.page(), "the Continue button");
    expect(await locator.evaluate((el) => el.tagName)).toBe("BUTTON");
  });

  it("resolves a quoted description and clicking it changes the page", async () => {
    await tools.click('the "Continue" button');
    expect(await session.page().locator("#done").textContent()).toBe("Continued");
  }, 30_000);

  it("resolves a labelled field via getByLabel and types into it", async () => {
    await tools.type("the Email field", "kyle@example.com");
    expect(await session.page().locator("input").inputValue()).toBe("kyle@example.com");
  }, 30_000);

  it("falls through to getByPlaceholder when role and label miss", async () => {
    const locator = await resolveTarget(session.page(), "the you@example.com field");
    expect(await locator.getAttribute("placeholder")).toBe("you@example.com");
  });

  it("resolves css= targets literally", async () => {
    const locator = await resolveTarget(session.page(), "css=#done");
    expect(await locator.getAttribute("id")).toBe("done");
  });

  it("resolves selectorHints echoed from read_page", async () => {
    const locator = await resolveTarget(session.page(), 'role=button name="Continue"');
    expect(await locator.evaluate((el) => el.tagName)).toBe("BUTTON");
  });

  it("selects options by visible label", async () => {
    await tools.select("the Plan dropdown", "Beta");
    expect(await session.page().locator("#plan").textContent()).toBe("beta");
  }, 30_000);

  it("throws with the target description when nothing matches", async () => {
    await expect(resolveTarget(session.page(), "the Nonexistent Chrome button")).rejects.toThrow(
      /could not resolve target "the Nonexistent Chrome button"/,
    );
  });

  it("readPage reports url, title, collapsed text, and elements with selectorHints", async () => {
    const snapshot = await tools.readPage();
    expect(snapshot.title).toBe("Widget Demo");
    expect(snapshot.visibleText).toContain("Widget Demo");
    expect(snapshot.visibleText).toContain("widget demonstration");
    expect(snapshot.visibleText).not.toMatch(/\n/);
    expect(snapshot.visibleText.length).toBeLessThanOrEqual(4000);
    expect(snapshot.elements.length).toBeLessThanOrEqual(80);
    expect(snapshot.elements).toContainEqual({
      role: "button",
      name: "Continue",
      selectorHint: 'role=button name="Continue"',
    });
    expect(snapshot.elements.some((e) => e.role === "link" && e.name === "See pricing")).toBe(true);
  });

  it("screenshot writes under artifactsDir and returns a relative path", async () => {
    const relative = await tools.screenshot("evidence one!");
    expect(relative).toBe(join("screenshots", "evidence-one.png"));
    expect(existsSync(join(artifactsDir, relative))).toBe(true);
  }, 30_000);
});

// Regression coverage for the navigation race the harness surfaced: a click
// that triggers `location.href` from JS (even behind a setTimeout) must be
// settled before the next read, and readPage must never see a mid-parse DOM.
describe("navigation settle after actions", () => {
  let session: BrowserSession;
  let tools: BrowserTools;
  let workDir: string;

  const PAGE_A = `<!DOCTYPE html>
<html>
  <head><title>Page A</title></head>
  <body>
    <h1>Page A</h1>
    <button onclick="setTimeout(() => { location.href = 'b.html'; }, 150)">Go</button>
    <input aria-label="Jump" onkeydown="if (event.key === 'Enter') setTimeout(() => { location.href = 'b.html'; }, 150)">
    <button onclick="document.getElementById('local').textContent = 'stayed'">Stay</button>
    <p id="local"></p>
  </body>
</html>`;

  // Page B builds its content from an inline script, like the fixtures'
  // confirm.html — an unsettled read would see an empty page.
  const PAGE_B = `<!DOCTYPE html>
<html>
  <head><title>Page B</title></head>
  <body>
    <p id="msg"></p>
    <script>document.getElementById("msg").textContent = "Arrived at page B";</script>
  </body>
</html>`;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pb-nav-"));
    await writeFile(join(workDir, "a.html"), PAGE_A, "utf8");
    await writeFile(join(workDir, "b.html"), PAGE_B, "utf8");
    session = new BrowserSession();
    await session.launch();
    await session.freshContext();
    tools = createBrowserTools(session, workDir);
  }, 60_000);

  afterAll(async () => {
    await session.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("click settles a JS-triggered (location.href) navigation before the next read", async () => {
    await tools.navigate(pathToFileURL(join(workDir, "a.html")).href);
    await tools.click("the Go button");
    // No explicit wait: an immediate read must already see the new document.
    const snapshot = await tools.readPage();
    expect(snapshot.title).toBe("Page B");
    expect(snapshot.visibleText).toContain("Arrived at page B");
  }, 30_000);

  it("press settles a JS-triggered navigation the same way", async () => {
    await tools.navigate(pathToFileURL(join(workDir, "a.html")).href);
    await tools.click("the Jump field");
    await tools.press("Enter");
    const snapshot = await tools.readPage();
    expect(snapshot.title).toBe("Page B");
    expect(snapshot.visibleText).toContain("Arrived at page B");
  }, 30_000);

  it("click that does not navigate is a no-op settle: same page, mutation visible", async () => {
    await tools.navigate(pathToFileURL(join(workDir, "a.html")).href);
    await tools.click("the Stay button");
    const snapshot = await tools.readPage();
    expect(snapshot.title).toBe("Page A");
    expect(snapshot.visibleText).toContain("stayed");
  }, 30_000);
});
