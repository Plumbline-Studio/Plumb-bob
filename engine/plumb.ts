// Layer 1 — Plumb (functional). "Does it work?"
//
// Goal-directed agentic browser testing against the preview deploy. For each
// declared flow we hand the agent a high-level goal and the Playwright MCP tool
// surface, and let it pursue the goal like a person would — no selectors, no
// scripted clicks. It reports pass/fail with reasoning per goal; screenshots it
// takes along the way are attached to the report.

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
    "Call this exactly once when you have reached a conclusion about the goal. " +
    "Report whether the flow works as a real user would need it to, with concrete reasoning grounded in what you observed.",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pass", "fail"] },
      reasoning: {
        type: "string",
        description: "Concrete, evidence-grounded reasoning for the verdict (what you saw, what worked or broke).",
      },
    },
    required: ["status", "reasoning"],
  },
};

const SYSTEM = `You are Plumb Bob's functional-verification agent. You test a live web app through a real browser (Playwright MCP tools) the way an ordinary person would — pursuing intent, not clicking pre-chosen selectors.

Rules:
- Start by navigating to the goal's URL as a fresh visitor.
- Pursue the goal end to end. Read the page, take screenshots at meaningful moments, click, type, and navigate as needed.
- Judge success by whether a real user could actually accomplish the goal — dead CTAs, blocking errors, or broken states are failures even if the page "loads".
- Take at least one screenshot showing the decisive state before you conclude.
- When you are done, call report_goal exactly once. Do not keep exploring after you have enough evidence.`;

function goalsFor(config: Config): { goal: string; route: string }[] {
  const entries = Object.entries(config.consumer.playscripts ?? {});
  if (entries.length === 0) {
    return [{ goal: "Load the application and confirm it renders a usable initial screen.", route: "/" }];
  }
  return entries.map(([name, spec]) => {
    const route = spec.route ?? "/";
    return {
      route,
      goal: `Exercise the "${name}" flow starting at ${route} and confirm a real user can complete it end to end.`,
    };
  });
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
      `Goal: ${goal}\n\nPreview URL to test: ${url}\n\n` +
      `Begin by navigating there as a fresh visitor, then pursue the goal and report your verdict.`;

    const result = await runAgentLoop<GoalVerdict>(
      client,
      config,
      SYSTEM,
      firstMessage,
      tools,
      async (name, input) => {
        if (name === "report_goal") {
          const status = input.status === "fail" ? "fail" : "pass";
          const reasoning = String(input.reasoning ?? "");
          return {
            content: [{ type: "text", text: "Verdict recorded." }],
            finish: { status, reasoning },
          };
        }
        return mcp.call(name, input);
      },
    );

    if (result.finished) {
      goals.push({
        goal,
        status: result.finished.status,
        reasoning: result.finished.reasoning,
        screenshots: result.screenshots,
      });
    } else {
      // No verdict — the agent ran out of budget or stopped without concluding.
      // Treat as a functional failure: we could not confirm the flow works.
      goals.push({
        goal,
        status: "fail",
        reasoning:
          `Agent did not reach a verdict (${result.endReason} after ${result.steps} steps). ` +
          `Treating an unconfirmed flow as a failure.`,
        screenshots: result.screenshots,
      });
    }
  }

  const status: PlumbLayer["status"] = goals.some((g) => g.status === "fail") ? "fail" : "pass";
  return { status, goals };
}
