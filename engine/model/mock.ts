/**
 * Scripted model client for harnesses and tests.
 *
 * MockModelClient satisfies the same ModelClient seam the real Anthropic
 * adapter does, but answers from a caller-supplied policy — a pure function
 * of the request and the turn counter. Deterministic, no I/O: this is what
 * lets the whole engine run (with the browser REALLY driving pages) without
 * an API key.
 *
 * The exported builders (textResponse, toolCall, doneResponse) keep harness
 * policies declarative: policy authors say what the "model" does, not how a
 * ModelResponse is shaped.
 */

import type { ModelClient, ModelRequest, ModelResponse } from "../types.js";

export type MockPolicy = (req: ModelRequest, state: { turn: number }) => ModelResponse;

export class MockModelClient implements ModelClient {
  private turn = 0;

  constructor(private readonly policy: MockPolicy) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const response = this.policy(req, { turn: this.turn });
    this.turn += 1;
    return response;
  }
}

/** A plain assistant text turn (no tool call). */
export function textResponse(text: string): ModelResponse {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

/** One tool invocation. The default id is stable per name — fine for the
 *  loop's per-turn pairing; pass explicit ids to call one tool twice in a turn. */
export function toolCall(
  name: string,
  input: Record<string, unknown>,
  id = `toolu_mock_${name}`,
): ModelResponse {
  return { content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use" };
}

/** The finish call that ends an agent-loop task. */
export function doneResponse(json: {
  outcome: "success" | "failure";
  reasoning: string;
}): ModelResponse {
  return toolCall("finish", json);
}

/** Last user-role text in the request — how policies see the task or the
 *  latest tool feedback without re-implementing message-walking. */
export function lastUserText(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i]!;
    if (msg.role !== "user") continue;
    return msg.content
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_result") {
          return typeof b.content === "string"
            ? b.content
            : b.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

/** First user-role text — the task the loop was started with. */
export function taskText(req: ModelRequest): string {
  const first = req.messages.find((m) => m.role === "user");
  if (!first) return "";
  return first.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}
