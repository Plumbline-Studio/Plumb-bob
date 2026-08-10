/**
 * Playwright chromium session owner.
 *
 * One BrowserSession per layer run: launch() once, freshContext() whenever
 * the flow needs a brand-new visitor (new incognito context + page — no
 * cookies, no storage), close() in a finally. Layers never touch Playwright
 * types; they get the Page through browser/tools.ts.
 *
 * Browsers are preinstalled (PLAYWRIGHT_BROWSERS_PATH); if the default
 * launch cannot find its executable we fall back to the known install path
 * rather than ever running `playwright install`.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const FALLBACK_BROWSERS_DIR = "/opt/pw-browsers";
/** Keep individual actions snappy — a hung locator should fail, not stall the run. */
const ACTION_TIMEOUT_MS = 10_000;

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private currentPage: Page | null = null;

  async launch(): Promise<void> {
    if (this.browser) return;
    try {
      this.browser = await chromium.launch({ headless: true });
    } catch (err) {
      // Only when the default launch fails: point at the preinstalled
      // chromium directly. Any failure there propagates — a browser that
      // cannot start is a setup problem, not a step outcome.
      const executablePath = findInstalledChromium();
      if (!executablePath) throw err;
      this.browser = await chromium.launch({ headless: true, executablePath });
    }
  }

  /** A brand-new visitor: fresh incognito context and page, old state discarded. */
  async freshContext(): Promise<void> {
    if (!this.browser) throw new Error("BrowserSession.launch() must be called first");
    if (this.context) await this.context.close();
    this.context = await this.browser.newContext();
    this.context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    this.currentPage = await this.context.newPage();
  }

  page(): Page {
    if (!this.currentPage) {
      throw new Error("no active page — call freshContext() before browser actions");
    }
    return this.currentPage;
  }

  async close(): Promise<void> {
    if (!this.browser) return;
    await this.browser.close();
    this.browser = null;
    this.context = null;
    this.currentPage = null;
  }
}

/** Resolve /opt/pw-browsers/chromium<version>/chrome-linux/chrome if present. */
function findInstalledChromium(): string | null {
  let entries: string[];
  try {
    entries = readdirSync(FALLBACK_BROWSERS_DIR);
  } catch {
    // Fallback dir absent on this machine — nothing to offer beyond the
    // original launch error.
    return null;
  }
  const dir = entries
    .filter((e) => e.startsWith("chromium") && !e.startsWith("chromium_headless"))
    .sort()
    .pop();
  return dir ? join(FALLBACK_BROWSERS_DIR, dir, "chrome-linux", "chrome") : null;
}
