// Layer 1 — Plumb (functional). "Does it work?"
//
// Usability COVERAGE, not happy-path. For each declared flow the agent doesn't
// just try to reach the goal — it inventories every interactive element on each
// screen (from the accessibility tree, so coverage survives redesigns without
// brittle selectors) and exercises each one. Every auth provider, button, link,
// and form gets tried; anything that errors, dead-ends, or fires a failed
// network request / console error is a failure — even off the happy path.
//
// Two detection channels: (1) the agent's own judgment from what it sees, and
// (2) a deterministic engine backstop that reads the browser's network log and
// fails the flow on any HTTP error (>= 400). That backstop is what catches a
// broken OAuth redirect that leaves the page looking fine.

import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { PlumbLayer, PlumbGoal } from "./types.js";
import type { PlaywrightMcp } from "./mcp.js";
import { runAgentLoop } from "./loop.js";

interface GoalVerdict {
  status: "pass" | "fail";
  reasoning: string;
}

const REPORT_GOAL_TOOL: Anthropic.Tool = {
  name: "report_goal",
  description:
    "Call this exactly once when you have inventoried and exercised the controls on every screen this flow reaches. " +
    "status is 'fail' if ANY control errored, dead-ended, or triggered a failed network request / console error — even one off the happy path.",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pass", "fail"] },
      reasoning: {
        type: "string",
        description:
          "List the controls you exercised (buttons, links, auth providers, forms) and describe every failure concretely — the specific element and the error (URL + HTTP status where relevant).",
      },
    },
    required: ["status", "reasoning"],
  },
};

const SYSTEM = `You are Plumb Bob's functional-verification agent. Your job is exhaustive usability QA, NOT completing a happy path: verify that every interactive element on each screen actually works.

Method for each screen you reach:
1. Call browser_snapshot to inventory EVERY interactive element — buttons, links, form inputs, menus, and especially every authentication / social-login provider (Apple, Google, email, etc.). Do not settle for the one path that reaches the goal; enumerate the controls.
2. Exercise each control. Every auth provider button MUST be activated individually and its result observed — a broken OAuth redirect is exactly the kind of bug that hides off the happy path.
3. After interacting, call browser_network_requests and browser_console_messages. Any HTTP status >= 400, any console error, any dead end, blank state, or broken result is a FAILURE — attribute it to the specific control.
4. Take a screenshot of any failure.
5. Move through the flow's screens (reach sign-in / auth screens even if the happy path wouldn't), repeating the inventory-and-exercise on each.

When finished, call report_goal exactly once: 'fail' if ANY control failed, else 'pass'. In reasoning, list what you exercised and every failure with its specific error.`;

function goalsFor(config: Config): { goal: string; route: string }[] {
  const entries = Object.entries(config.consumer.playscripts ?? {});
  if (entries.length === 0) {
    return [{ goal: "Verify every interactive element on the app's initial screens works.", route: "/" }];
  }
  return entries.map(([name, spec]) => {
    const route = spec.route ?? "/";
    return {
      route,
      goal: `Verify every interactive element across the "${name}" flow's screens (starting at ${route}) works — every button, link, form, and auth provider.`,
    };
  });
}

// High-signal network failures. Tolerant of the exact log format the MCP server
// emits — matches an HTTP 4xx/5xx status token or an explicit load failure on a
// line. Conservative on purpose: it only ever ADDS a failure, never clears one.
const NETWORK_FAIL =
  /(=>\s*\[?\s*[45]\d\d)|(\]\s*[45]\d\d\b)|(\bstatus[:=]?\s*[45]\d\d\b)|(net::ERR)|(Failed to load)|(\[[45]\d\d\b)/i;
// Console lines that look error-level (surfaced as evidence; not an auto-fail on
// their own, since console noise is common — the agent already weighs them).
const CONSOLE_ERROR = /^\s*(\[?error\]?[:>\s]|error\b.*:|❌|uncaught|unhandled)/i;

function matchingLines(text: string, re: RegExp): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && re.test(l));
}

export async function runPlumb(
  client: Anthropic,
  mcp: PlaywrightMcp,
  config: Config,
): Promise<PlumbLayer> {
  const tools = [...(await mcp.anthropicTools()), REPORT_GOAL_TOOL];
  const goals: PlumbGoal[] = [];

  for (const { goal, route } of goalsFor(config)) {
    const url = new URL(route, config.previewUrl).toString();
    const firstMessage =
      `Goal: ${goal}\n\nStart URL: ${url}\n\n` +
      `Navigate there as a fresh visitor, then inventory and exercise every interactive element on each screen this flow reaches — ` +
      `including reaching the sign-in / auth screen and trying every login provider. Treat any erroring control as a failure.`;

    const result = await runAgentLoop<GoalVerdict>(
      client,
      config,
      SYSTEM,
      firstMessage,
      tools,
      async (name, input) => {
        if (name === "report_goal") {
          const status = input.status === "fail" ? "fail" : "pass";
          return {
            content: [{ type: "text", text: "Verdict recorded." }],
            finish: { status, reasoning: String(input.reasoning ?? "") },
          };
        }
        return mcp.call(name, input);
      },
    );

    // Engine backstop — read the browser's own logs regardless of what the agent
    // concluded. A failed network request fails the flow even if the agent
    // called it a pass.
    const netFailures = matchingLines(await mcp.networkText(), NETWORK_FAIL);
    const consoleErrors = matchingLines(await mcp.consoleText(), CONSOLE_ERROR);

    let status: PlumbGoal["status"] = result.finished?.status ?? "fail";
    let reasoning =
      result.finished?.reasoning ??
      `Agent did not reach a verdict (${result.endReason} after ${result.steps} steps); treating an unconfirmed flow as a failure.`;

    if (netFailures.length > 0) {
      status = "fail";
      reasoning +=
        `\n\nEngine backstop — ${netFailures.length} failed network request(s) observed during this flow:\n` +
        netFailures.slice(0, 10).map((l) => `  - ${l}`).join("\n");
    }
    if (consoleErrors.length > 0) {
      reasoning +=
        `\n\nConsole errors observed:\n` +
        consoleErrors.slice(0, 10).map((l) => `  - ${l}`).join("\n");
    }

    goals.push({ goal, status, reasoning, screenshots: result.screenshots });
  }

  const status: PlumbLayer["status"] = goals.some((g) => g.status === "fail") ? "fail" : "pass";
  return { status, goals };
}
