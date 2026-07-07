// Offline unit test for the Playscript parser — no network, no browser, no API
// key. This is what the first local smoke run exercises. Run: `npm test`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parsePlayscript } from "./level.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("parsePlayscript:");

check("extracts flow name and purpose", () => {
  const p = parsePlayscript(
    "PLAYSCRIPT: Demo Flow\nPurpose: Do a thing\nand keep the invariant.\n\n 1. User  Opens the app.\n",
  );
  assert.equal(p.flow, "Demo Flow");
  assert.equal(p.purpose, "Do a thing and keep the invariant.");
  assert.equal(p.steps.length, 1);
});

check("parses numbered steps with actor + action", () => {
  const p = parsePlayscript(
    "PLAYSCRIPT: X\nPurpose: y\n\n 1. User    Opens preview.\n 2. System  Renders the welcome screen.\n 3. Bob     Verifies a row exists.\n",
  );
  assert.deepEqual(
    p.steps.map((s) => [s.n, s.actor]),
    [[1, "User"], [2, "System"], [3, "Bob"]],
  );
  assert.equal(p.steps[1].action, "Renders the welcome screen.");
});

check("joins wrapped continuation lines into the step action", () => {
  const p = parsePlayscript(
    "PLAYSCRIPT: X\nPurpose: y\n\n 2. System  Displays welcome screen with brand tokens applied\n            (copper on near-black).\n",
  );
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].action, "Displays welcome screen with brand tokens applied (copper on near-black).");
});

check("flags inline = FAIL conditions", () => {
  const p = parsePlayscript(
    "PLAYSCRIPT: X\nPurpose: y\n\n10. User    Dismisses the paywall.\n11. System  Allows continuation. (Hard-block here = FAIL)\n",
  );
  assert.equal(p.steps.find((s) => s.n === 10)!.declaresFail, false);
  assert.equal(p.steps.find((s) => s.n === 11)!.declaresFail, true);
});

check("ignores non-step prose (e.g. SCAFFOLD warning) between purpose and steps", () => {
  const p = parsePlayscript(
    "PLAYSCRIPT: X\nPurpose: y\n\n⚠ SCAFFOLD — reconcile before first run.\n\n 1. User  Opens preview URL.\n",
  );
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].n, 1);
});

check("parses the shipped example onboarding Playscript", () => {
  const here = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
  const examplePath = resolve(
    here,
    "..",
    "examples",
    "consumer-repo",
    "plumb-bob",
    "playscripts",
    "onboarding.md",
  );
  const p = parsePlayscript(readFileSync(examplePath, "utf8"));
  assert.equal(p.flow, "New User Onboarding");
  assert.equal(p.steps.length, 15);
  // Step 11 declares a hard-fail; step 1 does not.
  assert.equal(p.steps.find((s) => s.n === 11)!.declaresFail, true);
  assert.equal(p.steps.find((s) => s.n === 1)!.declaresFail, false);
  // Actors are recognized across all three kinds.
  assert.ok(p.steps.some((s) => s.actor === "Bob"));
});

console.log(`\n${passed} checks passed.`);
