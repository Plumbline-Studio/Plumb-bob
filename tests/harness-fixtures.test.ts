/**
 * Cheap guards over the harness fixtures: every variant serves, every page
 * responds, the shared playscript parses with the veto step intact, goldens
 * keep their structural shape — and each fixture's deliberate defect is still
 * present (a "fixed" fixture would silently hollow out the eval).
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePlayscript } from "../engine/playscript.js";
import { serveFixture, type FixtureServer } from "../harness/server.js";

const FIXTURES = fileURLToPath(new URL("../harness/fixtures", import.meta.url));
const GOLDENS = fileURLToPath(new URL("../harness/goldens", import.meta.url));
const VARIANTS = ["site-green", "site-broken", "site-diverged", "site-veto"] as const;

describe.each(VARIANTS)("%s", (variant) => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await serveFixture(join(FIXTURES, variant));
  });
  afterAll(async () => {
    await server.close();
  });

  it("serves all three pages with 200 and html content", async () => {
    for (const page of ["/index.html", "/order.html", "/confirm.html"]) {
      const res = await fetch(`${server.url}${page}`);
      expect(res.status, page).toBe(200);
      expect(res.headers.get("content-type"), page).toContain("text/html");
      expect(await res.text(), page).toContain("Lantern");
    }
  });

  it("serves the stylesheet and maps / to the catalog", async () => {
    const css = await fetch(`${server.url}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const root = await fetch(`${server.url}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("Lantern Supply Co.");
  });

  it("returns 404 for missing files", async () => {
    const res = await fetch(`${server.url}/no-such-page.html`);
    expect(res.status).toBe(404);
  });

  it("ships a parseable playscript with 8 steps and a final veto step", async () => {
    const file = join(FIXTURES, variant, "plumb-bob", "playscripts", "order.playscript.md");
    const parsed = parsePlayscript(await readFile(file, "utf8"), "order.playscript.md");
    expect(parsed.name).toBe("Lantern Order");
    expect(parsed.purpose).toContain("honest");
    expect(parsed.steps).toHaveLength(8);
    expect(parsed.steps.map((s) => s.actor)).toEqual([
      "User", "System", "User", "System", "User", "System", "User", "System",
    ]);
    expect(parsed.steps[7]?.isVeto).toBe(true);
    expect(parsed.steps.slice(0, 7).every((s) => !s.isVeto)).toBe(true);
    expect(parsed.warnings).toEqual([]);
  });

  it("has a golden with the structural shape the runner compares", async () => {
    const golden = JSON.parse(
      await readFile(join(GOLDENS, `${variant}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(["pass", "fail", "veto"]).toContain(golden.result);
    expect(["pass", "fail", "skipped"]).toContain(golden.plumb_status);
    expect(["pass", "fail", "divergence", "skipped"]).toContain(golden.level_status);
    for (const key of ["failed_steps", "diverged_steps"] as const) {
      expect(Array.isArray(golden[key]), key).toBe(true);
      expect((golden[key] as unknown[]).every((n) => Number.isInteger(n)), key).toBe(true);
    }
    expect(typeof golden.vetoes_expected).toBe("boolean");
    expect(Number.isInteger(golden.min_screenshots)).toBe(true);
    expect(golden.min_screenshots as number).toBeGreaterThanOrEqual(0);
  });
});

describe("fixture defects stay honest", () => {
  const read = (variant: string, file: string): Promise<string> =>
    readFile(join(FIXTURES, variant, file), "utf8");

  it("site-green wires the Place Order handler", async () => {
    expect(await read("site-green", "order.js")).toContain("addEventListener");
  });

  it("site-broken really has a dead submit button (no handler wiring)", async () => {
    expect(await read("site-broken", "order.js")).not.toContain("addEventListener");
  });

  it("site-diverged routes submit through the newsletter interstitial", async () => {
    expect(await read("site-diverged", "order.js")).toContain("newsletter.html");
    const interstitial = await read("site-diverged", "newsletter.html");
    expect(interstitial).toContain("No thanks, continue to my order");
    // The interstitial diverges from the script but must not break the flow.
    expect(interstitial).toContain("confirm.html");
  });

  it("site-veto's confirmation carries the pre-checked recurring charge and urgency copy", async () => {
    const confirm = await read("site-veto", "confirm.html");
    expect(confirm).toMatch(/type="checkbox" checked/);
    expect(confirm).toContain("$4.99/mo");
    expect(confirm).toMatch(/Only 2 left in stock/);
    expect(confirm).toMatch(/11 people are viewing/);
  });

  it("site-green's confirmation stays clean of veto bait", async () => {
    const confirm = await read("site-green", "confirm.html");
    expect(confirm).not.toContain("/mo");
    expect(confirm).not.toMatch(/Only \d+ left/);
  });
});
