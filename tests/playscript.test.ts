import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlayscripts, parsePlayscript } from "../engine/playscript.js";

const ONBOARDING_PATH = fileURLToPath(
  new URL("../examples/consumer-repo/plumb-bob/playscripts/onboarding.md", import.meta.url),
);

describe("parsePlayscript: staged onboarding example", () => {
  const parsed = parsePlayscript(readFileSync(ONBOARDING_PATH, "utf8"), "onboarding.md");

  it("reads header and multi-line purpose", () => {
    expect(parsed.name).toBe("New User Onboarding");
    expect(parsed.file).toBe("onboarding.md");
    expect(parsed.purpose).toBe(
      "A new visitor completes onboarding, a profile row persists " +
        "(migration 0011), analytics fire, and the soft paywall behaves as " +
        "designed — dismissible, not blocking.",
    );
  });

  it("parses all 15 steps with correct actors", () => {
    expect(parsed.steps).toHaveLength(15);
    expect(parsed.steps.map((s) => s.actor)).toEqual([
      "User", "System", "User", "System", "User", "System", "Bob", "User",
      "System", "User", "System", "Bob", "Bob", "User", "System",
    ]);
    expect(parsed.steps.map((s) => s.n)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    // Canonical actors keep rawActor identical
    expect(parsed.steps.every((s) => s.rawActor === s.actor)).toBe(true);
  });

  it("joins indented continuation lines single-spaced", () => {
    expect(parsed.steps[1]!.action).toBe(
      "Displays welcome screen with brand tokens applied " +
        "(copper on near-black; flag any default-theme leakage).",
    );
    expect(parsed.steps[6]!.action).toBe(
      "Verifies profile row written per migration 0011 (Supabase read-only check).",
    );
  });

  it("flags step 11 as hardFail and nothing else", () => {
    expect(parsed.steps[10]!.hardFail).toBe(true);
    expect(parsed.steps.filter((s) => s.hardFail)).toHaveLength(1);
  });

  it("finds no veto steps", () => {
    expect(parsed.steps.every((s) => !s.isVeto)).toBe(true);
  });

  it("reports the SCAFFOLD annotation block as warnings, not steps", () => {
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings[0]).toContain("SCAFFOLD");
    expect(parsed.warnings[0]).toMatch(/^onboarding\.md:\d+:/);
  });
});

const CHECKOUT = `PLAYSCRIPT: Checkout Integrity
Purpose: A member purchases a plan and the ledger
stays honest.

 1. User  Opens the pricing page.
 2. Payment API  Declines the card with a test decline code.
 3. System  Shows a recoverable error state.
 4. System  Confirms the ledger **never** records a failed charge as revenue.
`;

describe("parsePlayscript: synthetic checkout script", () => {
  const parsed = parsePlayscript(CHECKOUT, "checkout.playscript.md");

  it("maps a named external party to System, preserving rawActor", () => {
    const step = parsed.steps[1]!;
    expect(step.actor).toBe("System");
    expect(step.rawActor).toBe("Payment API");
    expect(step.action).toBe("Declines the card with a test decline code.");
  });

  it("detects the bold-never form alone in the final step as a veto", () => {
    expect(parsed.steps[3]!.isVeto).toBe(true);
    expect(parsed.steps.filter((s) => s.isVeto)).toHaveLength(1);
  });

  it("detects an explicit integrity veto in a non-final step", () => {
    const withVeto = CHECKOUT.replace(
      "Shows a recoverable error state.",
      "Confirms the audit trail **never** drops the decline (integrity veto).",
    );
    const p = parsePlayscript(withVeto, "checkout.playscript.md");
    expect(p.steps[2]!.isVeto).toBe(true);
  });

  it("does not treat bold-never in a middle step as a veto by itself", () => {
    const middleNever = CHECKOUT.replace(
      "Shows a recoverable error state.",
      "Shows an error and **never** charges the card.",
    );
    const p = parsePlayscript(middleNever, "checkout.playscript.md");
    expect(p.steps[2]!.isVeto).toBe(false);
  });
});

describe("parsePlayscript: malformed input", () => {
  it("throws with file:line when the header is missing", () => {
    expect(() => parsePlayscript("Purpose: nope\n\n 1. User  Acts.\n", "bad.md")).toThrow(
      /^bad\.md:1: expected "PLAYSCRIPT/,
    );
  });

  it("throws when Purpose is missing", () => {
    expect(() => parsePlayscript("PLAYSCRIPT: X\n\n 1. User  Acts.\n", "bad.md")).toThrow(
      /^bad\.md:3: expected "Purpose/,
    );
  });

  it("throws on a numbering gap", () => {
    const text = "PLAYSCRIPT: X\nPurpose: p.\n\n 1. User  Acts.\n 3. System  Reacts.\n";
    expect(() => parsePlayscript(text, "bad.md")).toThrow(
      /^bad\.md:5: step numbering must be continuous: expected 2, got 3/,
    );
  });

  it("throws when a step lacks the two-space actor separator", () => {
    const text = "PLAYSCRIPT: X\nPurpose: p.\n\n 1. User taps the button.\n";
    expect(() => parsePlayscript(text, "bad.md")).toThrow(/^bad\.md:4: step 1:/);
  });

  it("throws when there are no steps at all", () => {
    expect(() => parsePlayscript("PLAYSCRIPT: X\nPurpose: p.\n", "bad.md")).toThrow(
      /no numbered steps/,
    );
  });
});

describe("loadPlayscripts", () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads .md and .playscript.md sorted, skipping _drafts and non-md files", async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-scripts-"));
    const minimal = (name: string) =>
      `PLAYSCRIPT: ${name}\nPurpose: p.\n\n 1. User  Acts.\n`;
    await writeFile(join(dir, "checkout.playscript.md"), minimal("Checkout"));
    await writeFile(join(dir, "onboarding.md"), minimal("Onboarding"));
    await writeFile(join(dir, "_draft.md"), "not a playscript at all");
    await writeFile(join(dir, "notes.txt"), "ignore me");

    const scripts = await loadPlayscripts(dir);
    expect(scripts.map((s) => s.file)).toEqual(["checkout.playscript.md", "onboarding.md"]);
    expect(scripts.map((s) => s.name)).toEqual(["Checkout", "Onboarding"]);
  });
});
