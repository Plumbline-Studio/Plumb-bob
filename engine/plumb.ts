/**
 * Plumb layer: agentic functional verification against stated goals.
 *
 * Each goal gets a brand-new visitor (fresh incognito context) at the
 * preview URL and a QA agent that pursues the goal with browser tools,
 * reporting only what it actually observed. Goals come from the consumer
 * config (playscripts[flow].goals); when none are declared, one is
 * synthesized from the playscript's Purpose paragraph — the flow's own
 * definition of "working".
 */

import { runAgentTask } from "./agent-loop.js";
import { BrowserSession } from "./browser/session.js";
import { createBrowserTools } from "./browser/tools.js";
import type { EngineContext, GoalResult, ParsedPlayscript, PlumbLayer } from "./types.js";

const SYSTEM_PREAMBLE = [
  "You are a careful QA agent pursuing a user goal on a real website.",
  "Work the site with the browser tools as a genuine user would.",
  "Verify honestly: never claim behavior you did not directly observe on the page.",
  "After an action that should change the page, you may use the wait tool and read_page again before concluding the page did not change.",
  "Take a screenshot at meaningful moments as evidence.",
  "When the goal is met — or you are certain it cannot be — call finish with an honest outcome and your reasoning.",
].join(" ");

const runPlumb = async (
  ctx: EngineContext,
  playscript: ParsedPlayscript,
): Promise<PlumbLayer> => {
  const goals = goalsFor(ctx, playscript);
  const session = new BrowserSession();
  await session.launch();
  try {
    const tools = createBrowserTools(session, ctx.artifactsDir);
    const results: GoalResult[] = [];
    for (const [index, goal] of goals.entries()) {
      ctx.log(`plumb: goal ${index + 1}/${goals.length}: ${goal}`);
      await tools.freshContext();
      await tools.navigate(ctx.previewUrl);
      const task = await runAgentTask({
        model: ctx.model,
        tools,
        task: `Goal: ${goal}\n\nYou are already on the site under test (${ctx.previewUrl}). Pursue this goal and verify it honestly.`,
        systemPreamble: SYSTEM_PREAMBLE,
        maxTurns: ctx.config.agent.max_steps,
        screenshotPrefix: `plumb-goal-${index + 1}`,
        artifactsDir: ctx.artifactsDir,
      });
      results.push({
        goal,
        status: task.outcome === "success" ? "pass" : "fail",
        reasoning: task.reasoning,
        screenshots: task.screenshots,
      });
    }
    return {
      status: results.some((r) => r.status === "fail") ? "fail" : "pass",
      goals: results,
    };
  } finally {
    await session.close();
  }
};

/** Declared goals win; otherwise the Purpose paragraph is the goal. */
function goalsFor(ctx: EngineContext, playscript: ParsedPlayscript): string[] {
  const flow = flowNameFromFile(playscript.file);
  const declared = ctx.config.playscripts[flow]?.goals;
  if (declared && declared.length > 0) return declared;
  return [`Verify this flow works as described: ${playscript.purpose}`];
}

function flowNameFromFile(file: string): string {
  return file.replace(/\.playscript\.md$/, "").replace(/\.md$/, "");
}

export default runPlumb;
