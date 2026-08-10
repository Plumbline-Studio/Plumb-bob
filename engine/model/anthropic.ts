/**
 * Anthropic model adapter.
 *
 * Default-exports a factory `(opts?: { apiKey?: string }) => ModelClient`
 * (the contract engine/run.ts loads by). Maps the engine's ModelRequest onto
 * messages.create and the response back onto ModelResponse; everything about
 * model choice (PLUMB_BOB_MODEL, default "claude-sonnet-4-5"), retries, and
 * SDK shape stays hidden behind the ModelClient seam. No streaming — layer
 * agents only ever need whole turns.
 */

import Anthropic, { APIError } from "@anthropic-ai/sdk";
import type { ContentBlock, ModelClient, ModelRequest, ModelResponse } from "../types.js";

const DEFAULT_MODEL = "claude-sonnet-4-5";
/** Two retries beyond the initial attempt, exponential backoff. */
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;

export default function createAnthropicClient(opts?: { apiKey?: string }): ModelClient {
  const client = new Anthropic({
    ...(opts?.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    // The engine owns retry policy (429/5xx below); the SDK must not stack
    // its own retries on top.
    maxRetries: 0,
  });
  const model = process.env.PLUMB_BOB_MODEL ?? DEFAULT_MODEL;

  return {
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const response = await withRetries(() =>
        client.messages.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          // The engine's block types are a structural subset of the SDK's
          // param types (text, base64 png image, tool_use, tool_result).
          messages: req.messages as unknown as Anthropic.MessageParam[],
          ...(req.tools ? { tools: req.tools as unknown as Anthropic.Tool[] } : {}),
        }),
      );
      return {
        content: mapContent(response.content),
        stopReason:
          response.stop_reason === "tool_use"
            ? "tool_use"
            : response.stop_reason === "max_tokens"
              ? "max_tokens"
              : "end_turn",
      };
    },
  };
}

function mapContent(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    if (block.type === "tool_use") {
      out.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
    // Other block kinds (thinking, server tool results) have no engine
    // equivalent and are dropped; layers never request them.
  }
  return out;
}

/** Retry only rate limits and server errors — client errors are bugs, not weather. */
async function withRetries<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const retryable =
        err instanceof APIError &&
        typeof err.status === "number" &&
        (err.status === 429 || err.status >= 500);
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, BACKOFF_BASE_MS * 2 ** attempt));
    }
  }
}
