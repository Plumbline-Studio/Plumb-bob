// Thin wrapper around the Anthropic SDK.
//
// Model default is claude-opus-4-8 (the current Opus tier) with adaptive
// thinking — the browser-driving and principled-scoring passes are both
// judgment-heavy, so we want the model reasoning between tool calls. Model and
// effort are configurable per-run (plumb-bob.config.json / Action inputs) so a
// consumer can dial cost vs. depth without touching the engine.

import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";

export function makeClient(config: Config): Anthropic {
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the plumb/level/true layers.");
  }
  // 10-minute default timeout is fine; agentic browser turns can be long but
  // each individual API call is bounded. We stream the True call (large output).
  return new Anthropic({ apiKey: config.anthropicApiKey });
}

// Shared request knobs. Adaptive thinking is the only supported thinking mode
// on Opus 4.8; effort controls depth. display:"omitted" (the default) keeps the
// thinking text out of the response — we don't surface it, so no need to pay to
// summarize it.
export function thinkingParams(config: Config) {
  return {
    thinking: { type: "adaptive" as const },
    output_config: { effort: config.effort },
  };
}
