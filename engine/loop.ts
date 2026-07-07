// The manual agentic tool-use loop shared by the Plumb and Level layers.
//
// We drive the loop ourselves (rather than the SDK tool runner) because we need
// to: intercept screenshots, enforce a hard step budget, and end the loop the
// moment the agent calls a dedicated "finish" tool with its structured verdict.

import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import { thinkingParams } from "./anthropic.js";

type ToolResultContent = Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

export interface ToolOutcome<T> {
  content: ToolResultContent;
  isError?: boolean;
  screenshots?: string[];
  // When a finish tool is called, its validated payload — ends the loop.
  finish?: T;
}

export interface LoopResult<T> {
  finished: T | null;
  screenshots: string[];
  steps: number;
  // A short human-readable reason the loop ended, for the report note.
  endReason: "finished" | "end_turn" | "max_steps";
}

export async function runAgentLoop<T>(
  client: Anthropic,
  config: Config,
  system: string,
  firstUserMessage: string,
  tools: Anthropic.Tool[],
  dispatch: (name: string, input: Record<string, unknown>) => Promise<ToolOutcome<T>>,
): Promise<LoopResult<T>> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: firstUserMessage },
  ];
  const allScreenshots: string[] = [];
  let steps = 0;

  while (steps < config.maxSteps) {
    const stream = client.messages.stream({
      model: config.model,
      max_tokens: 16000,
      system,
      tools,
      messages,
      ...thinkingParams(config),
    });
    const response = await stream.finalMessage();
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return { finished: null, screenshots: allScreenshots, steps, endReason: "end_turn" };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let finished: T | null = null;

    for (const tu of toolUses) {
      steps++;
      const outcome = await dispatch(tu.name, (tu.input ?? {}) as Record<string, unknown>);
      if (outcome.screenshots) allScreenshots.push(...outcome.screenshots);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: outcome.content,
        is_error: outcome.isError,
      });
      if (outcome.finish !== undefined && finished === null) finished = outcome.finish;
    }

    messages.push({ role: "user", content: toolResults });

    if (finished !== null) {
      return { finished, screenshots: allScreenshots, steps, endReason: "finished" };
    }
  }

  return { finished: null, screenshots: allScreenshots, steps, endReason: "max_steps" };
}
