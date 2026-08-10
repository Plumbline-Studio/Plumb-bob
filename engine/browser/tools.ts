/**
 * BrowserTools over a live Playwright page.
 *
 * The seam layers drive (see types.ts). Targets are human descriptions
 * ("the Continue button"), selectorHints echoed from readPage()
 * (`role=button name="Continue"`), or explicit CSS (`css=#submit`).
 * Resolution order for descriptions follows Playwright's own preference:
 * getByRole, getByLabel, getByText, getByPlaceholder — first locator that
 * matches anything wins.
 *
 * Every action auto-waits Playwright-style; failures throw with the target
 * description in the message so agent transcripts stay diagnosable. Actions
 * that can trigger navigation (click/press/select) additionally settle
 * JS-driven navigations before returning (see actAndSettle), and readPage()
 * never reads a mid-parse DOM.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { errors as playwrightErrors, type Locator, type Page } from "playwright";
import type { BrowserTools, PageElement, PageSnapshot } from "../types.js";
import type { BrowserSession } from "./session.js";

const VISIBLE_TEXT_CAP = 4000;
const ELEMENTS_CAP = 80;
const NETWORK_QUIET_TIMEOUT_MS = 3000;
/** How long after an action we watch for a navigation to begin. */
const NAV_DETECT_WINDOW_MS = 500;
/** Total budget for settling a detected navigation (detect window included). */
const NAV_SETTLE_TOTAL_MS = 2000;
/** Brief network-quiet window readPage waits before extracting the DOM. */
const READ_QUIET_TIMEOUT_MS = 1000;

/** Description words that imply an ARIA role, e.g. "the Email field" → textbox. */
const ROLE_WORDS: Record<string, string> = {
  button: "button",
  link: "link",
  checkbox: "checkbox",
  radio: "radio",
  tab: "tab",
  heading: "heading",
  textbox: "textbox",
  field: "textbox",
  input: "textbox",
  dropdown: "combobox",
  select: "combobox",
  combobox: "combobox",
  option: "option",
  menuitem: "menuitem",
  switch: "switch",
  slider: "slider",
};

/** Roles worth surfacing to the model from the aria snapshot. */
const SNAPSHOT_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "heading",
]);

export function createBrowserTools(session: BrowserSession, artifactsDir: string): BrowserTools {
  return {
    async navigate(url: string): Promise<void> {
      await session.page().goto(url, { waitUntil: "domcontentloaded" });
    },

    async freshContext(): Promise<void> {
      await session.freshContext();
    },

    async click(target: string): Promise<void> {
      await withTarget(target, "click", async () => {
        const page = session.page();
        const locator = await resolveTarget(page, target);
        await actAndSettle(page, () => locator.click());
      });
    },

    async type(target: string, text: string): Promise<void> {
      await withTarget(target, "type into", async () => {
        const locator = await resolveTarget(session.page(), target);
        await locator.fill(text);
      });
    },

    async press(key: string): Promise<void> {
      await withTarget(key, "press", async () => {
        const page = session.page();
        await actAndSettle(page, () => page.keyboard.press(key));
      });
    },

    async select(target: string, value: string): Promise<void> {
      await withTarget(target, "select in", async () => {
        const page = session.page();
        const locator = await resolveTarget(page, target);
        await actAndSettle(page, async () => {
          // Human-facing option label first; fall back to the value attribute.
          try {
            await locator.selectOption({ label: value });
          } catch {
            await locator.selectOption(value);
          }
        });
      });
    },

    async waitForLoad(): Promise<void> {
      const page = session.page();
      await page.waitForLoadState("domcontentloaded");
      // Network quiet is best-effort: long-polling apps never go idle, and
      // that must not fail the step — only the timeout is absorbed.
      try {
        await page.waitForLoadState("networkidle", { timeout: NETWORK_QUIET_TIMEOUT_MS });
      } catch (err) {
        if (!(err instanceof playwrightErrors.TimeoutError)) throw err;
        await page.waitForTimeout(500);
      }
    },

    async screenshot(name: string): Promise<string> {
      const safe = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "shot";
      const relative = join("screenshots", `${safe}.png`);
      const absolute = join(artifactsDir, relative);
      mkdirSync(dirname(absolute), { recursive: true });
      await session.page().screenshot({ path: absolute });
      return relative;
    },

    async readPage(): Promise<PageSnapshot> {
      const page = session.page();
      // A read fired right after a navigation can land on a mid-parse DOM
      // (inline scripts still populating content). Wait for the document,
      // then a brief network-quiet period, before extracting anything.
      await page.waitForLoadState("domcontentloaded");
      try {
        await page.waitForLoadState("networkidle", { timeout: READ_QUIET_TIMEOUT_MS });
      } catch (err) {
        if (!(err instanceof playwrightErrors.TimeoutError)) throw err;
      }
      // String-form evaluate: the engine compiles without the DOM lib, so
      // `document` only exists inside the page.
      const rawText = String(
        await page.evaluate('document.body ? document.body.innerText : ""'),
      );
      const visibleText = rawText.replace(/\s+/g, " ").trim().slice(0, VISIBLE_TEXT_CAP);
      return {
        url: page.url(),
        title: await page.title(),
        visibleText,
        elements: await snapshotElements(page),
      };
    },
  };
}

/**
 * Run one input action and settle any navigation it triggers.
 *
 * Playwright auto-waits same-call navigations, but a JS-triggered one
 * (`location.href = …`, possibly behind a setTimeout) starts AFTER the click
 * resolves — an immediate readPage() would then see the pre-navigation page.
 * The listener attaches before the action so an instant navigation is never
 * missed; after the action we race a short detection window, and only when a
 * navigation actually began do we wait for the new document plus network
 * quiet. The whole settle is bounded (~2s) and absorbs only timeouts — when
 * nothing navigates this is a cheap no-op.
 */
async function actAndSettle(page: Page, action: () => Promise<void>): Promise<void> {
  let navigated = false;
  let signalNavigation = (): void => {};
  const navigationStarted = new Promise<void>((res) => {
    signalNavigation = res;
  });
  const onNav = (): void => {
    navigated = true;
    signalNavigation();
  };
  page.on("framenavigated", onNav);
  try {
    await action();
    const deadline = Date.now() + NAV_SETTLE_TOTAL_MS;
    if (!navigated) {
      await Promise.race([navigationStarted, page.waitForTimeout(NAV_DETECT_WINDOW_MS)]);
    }
    if (!navigated) return;
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: remainingMs(deadline) });
      await page.waitForLoadState("networkidle", { timeout: remainingMs(deadline) });
    } catch (err) {
      // Budget exhausted: hand the page back as-is — the agent's wait tool
      // and re-read cover the long tail; anything else is a real failure.
      if (!(err instanceof playwrightErrors.TimeoutError)) throw err;
    }
  } finally {
    page.off("framenavigated", onNav);
  }
}

function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/**
 * Resolve a target string to a Locator. Exported for direct testing — the
 * resolver is the piece most likely to misfire on real pages.
 */
export async function resolveTarget(page: Page, target: string): Promise<Locator> {
  if (target.startsWith("css=")) return page.locator(target.slice(4)).first();

  // selectorHint form emitted by readPage(): role=<role> name="<name>".
  const hint = target.match(/^role=([\w-]+)(?:\s+name="([\s\S]*)")?$/);
  if (hint) {
    const [, role, name] = hint;
    return name !== undefined
      ? page.getByRole(role as never, { name, exact: true }).first()
      : page.getByRole(role as never).first();
  }

  const { role, name } = parseDescription(target);
  const nameRegex = name ? new RegExp(escapeRegExp(name), "i") : undefined;
  const candidates: Locator[] = [];
  if (role) {
    candidates.push(
      nameRegex
        ? page.getByRole(role as never, { name: nameRegex })
        : page.getByRole(role as never),
    );
  } else if (nameRegex) {
    // No role word in the description: try the two most common actionables
    // before text-level matching.
    candidates.push(page.getByRole("button", { name: nameRegex }));
    candidates.push(page.getByRole("link", { name: nameRegex }));
  }
  if (name) {
    candidates.push(page.getByLabel(name, { exact: false }));
    candidates.push(page.getByText(name, { exact: false }));
    candidates.push(page.getByPlaceholder(name, { exact: false }));
  }

  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) return candidate.first();
  }
  throw new Error(
    `could not resolve target "${target}" on ${page.url()} — try a selectorHint from read_page or css=<selector>`,
  );
}

/** "the \"Continue\" button" → { role: "button", name: "Continue" }. */
function parseDescription(target: string): { role: string | null; name: string } {
  let text = target.trim().replace(/^(?:the|a|an)\s+/i, "");
  let role: string | null = null;
  // A trailing (or leading) role word describes the element kind, not its name.
  const words = text.split(/\s+/);
  const last = words[words.length - 1]?.toLowerCase() ?? "";
  const first = words[0]?.toLowerCase() ?? "";
  if (ROLE_WORDS[last] && words.length > 1) {
    role = ROLE_WORDS[last]!;
    text = words.slice(0, -1).join(" ");
  } else if (ROLE_WORDS[first] && words.length > 1) {
    role = ROLE_WORDS[first]!;
    text = words.slice(1).join(" ");
  } else if (words.length === 1 && ROLE_WORDS[last]) {
    role = ROLE_WORDS[last]!;
    text = "";
  }
  const name = text.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  return { role, name };
}

/**
 * Interactable elements from the aria snapshot, described for the model.
 * ariaSnapshot() yields YAML-ish lines like `- button "Continue"`; we lift
 * role and accessible name and echo a selectorHint the resolver understands.
 */
async function snapshotElements(page: Page): Promise<PageElement[]> {
  const snapshot = await page.locator("body").ariaSnapshot();
  const elements: PageElement[] = [];
  for (const line of snapshot.split("\n")) {
    const match = line.match(/^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
    if (!match) continue;
    const [, role, rawName] = match;
    if (!SNAPSHOT_ROLES.has(role!)) continue;
    const name = (rawName ?? "").replace(/\\(.)/g, "$1");
    elements.push({
      role: role!,
      name,
      selectorHint: name ? `role=${role} name="${name}"` : `role=${role}`,
    });
    if (elements.length >= ELEMENTS_CAP) break;
  }
  return elements;
}

/** Re-throw browser failures with the human target in front — the transcript
 *  must say what the agent was trying to touch. */
async function withTarget(target: string, verb: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(target)) throw err instanceof Error ? err : new Error(message);
    throw new Error(`failed to ${verb} "${target}": ${message}`);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
