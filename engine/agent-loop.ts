/**
 * The shared agentic tool-use loop.
 *
 * Both browser layers (plumb goals, level steps) are "give the model browser
 * tools, let it work, trust only what it observed" — this module is that
 * loop, once. Callers supply the task and the framing (systemPreamble); the
 * loop owns tool definitions, execution, transcript hygiene, and the honest
 * failure when maxTurns runs out.
 *
 * Browser actions may individually fail as legitimate step outcomes: each
 * tool execution is caught narrowly at that boundary and fed back to the
 * model as an explicit failure message — never swallowed, never fatal to the
 * loop. Everything else (model errors, artifact I/O) propagates.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserTools,
  ContentBlock,
  ModelClient,
  ModelMessage,
  ToolDef,
  ToolUseBlock,
} from "./types.js";

export interface AgentTaskOptions {
  model: ModelClient;
  tools: BrowserTools;
  /** What to accomplish, written for the model. */
  task: string;
  /** Role framing (system prompt) — who the agent is and how to behave. */
  systemPreamble: string;
  maxTurns?: number;
  /** Prepended to every screenshot name so parallel tasks never collide. */
  screenshotPrefix: string;
  /** Where screenshot() paths are relative to — needed to feed images back. */
  artifactsDir: string;
}

export interface AgentTaskResult {
  outcome: "success" | "failure";
  reasoning: string;
  /** Artifact-relative paths, in capture order. */
  screenshots: string[];
  transcriptSummary: string;
}

const DEFAULT_MAX_TURNS = 20;
/** History window: beyond this, older turns collapse into one summary block. */
const KEEP_MESSAGES = 20;
const MAX_TOKENS_PER_TURN = 4000;

const TARGET_SCHEMA = {
  type: "string",
  description:
    'Element to act on: a human description ("the Continue button"), a selectorHint from read_page, or "css=<selector>".',
};

const TOOL_DEFS: ToolDef[] = [
  {
    name: "navigate",
    description: "Navigate the browser to a URL.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "click",
    description: "Click an element on the page.",
    input_schema: {
      type: "object",
      properties: { target: TARGET_SCHEMA },
      required: ["target"],
    },
  },
  {
    name: "type",
    description: "Clear a form field and type text into it.",
    input_schema: {
      type: "object",
      properties: { target: TARGET_SCHEMA, text: { type: "string" } },
      required: ["target", "text"],
    },
  },
  {
    name: "press",
    description: 'Press a keyboard key, e.g. "Enter" or "Tab".',
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "select",
    description: "Choose an option (by visible label) in a select/dropdown.",
    input_schema: {
      type: "object",
      properties: { target: TARGET_SCHEMA, value: { type: "string" } },
      required: ["target", "value"],
    },
  },
  {
    name: "wait",
    description: "Wait for the page to finish loading and the network to go quiet.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "read_page",
    description:
      "Read the current page: url, title, visible text, and interactable elements with selectorHints.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "screenshot",
    description:
      "Capture a screenshot as evidence. You will be shown the image. Use short kebab-case names.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "finish",
    description:
      "End the task with your honest verdict. outcome must reflect only what you actually observed.",
    input_schema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["success", "failure"] },
        reasoning: { type: "string" },
      },
      required: ["outcome", "reasoning"],
    },
  },
];

export async function runAgentTask(opts: AgentTaskOptions): Promise<AgentTaskResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const messages: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: opts.task }] },
  ];
  const screenshots: string[] = [];
  const actionLog: string[] = [];
  let shotCounter = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await opts.model.complete({
      system: opts.systemPreamble,
      messages,
      tools: TOOL_DEFS,
      maxTokens: MAX_TOKENS_PER_TURN,
    });
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) {
      // Text-only turns stall the loop; nudge once per occurrence and keep
      // counting turns so a chatty model still terminates.
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Respond with tool calls only. When done, call finish." },
        ],
      });
      continue;
    }

    const results: ContentBlock[] = [];
    for (const call of toolUses) {
      if (call.name === "finish") {
        const outcome = call.input.outcome === "success" ? "success" : "failure";
        const reasoning = String(call.input.reasoning ?? "");
        actionLog.push(`finish(${outcome})`);
        return { outcome, reasoning, screenshots, transcriptSummary: actionLog.join("\n") };
      }
      results.push(
        await executeTool(call, opts, screenshots, actionLog, () => shotCounter++),
      );
    }
    messages.push({ role: "user", content: results });
    pruneHistory(messages, opts.task, actionLog);
  }

  return {
    outcome: "failure",
    reasoning:
      `Task did not finish within ${maxTurns} turns. ` +
      `Actions taken: ${actionLog.slice(-8).join("; ") || "none"}.`,
    screenshots,
    transcriptSummary: actionLog.join("\n"),
  };
}

/**
 * Execute one browser tool call. The narrow catch here is the step boundary:
 * a failed click/type/etc. is an honest observation the model must see, not
 * an exception the run dies on.
 */
async function executeTool(
  call: ToolUseBlock,
  opts: AgentTaskOptions,
  screenshots: string[],
  actionLog: string[],
  nextShot: () => number,
): Promise<ContentBlock> {
  const { tools } = opts;
  const asText = (text: string): ContentBlock => ({
    type: "tool_result",
    tool_use_id: call.id,
    content: text,
  });
  const arg = (key: string): string => String(call.input[key] ?? "");

  try {
    switch (call.name) {
      case "navigate":
        await tools.navigate(arg("url"));
        actionLog.push(`navigate(${arg("url")}) ok`);
        return asText(`Navigated to ${arg("url")}.`);
      case "click":
        await tools.click(arg("target"));
        actionLog.push(`click(${arg("target")}) ok`);
        return asText(`Clicked "${arg("target")}".`);
      case "type":
        await tools.type(arg("target"), arg("text"));
        actionLog.push(`type(${arg("target")}) ok`);
        return asText(`Typed into "${arg("target")}".`);
      case "press":
        await tools.press(arg("key"));
        actionLog.push(`press(${arg("key")}) ok`);
        return asText(`Pressed ${arg("key")}.`);
      case "select":
        await tools.select(arg("target"), arg("value"));
        actionLog.push(`select(${arg("target")}=${arg("value")}) ok`);
        return asText(`Selected "${arg("value")}" in "${arg("target")}".`);
      case "wait":
        await tools.waitForLoad();
        actionLog.push("wait ok");
        return asText("Page load settled.");
      case "read_page": {
        const snapshot = await tools.readPage();
        actionLog.push(`read_page(${snapshot.title || snapshot.url})`);
        return asText(JSON.stringify(snapshot));
      }
      case "screenshot": {
        const name = `${opts.screenshotPrefix}-${nextShot()}-${arg("name") || "shot"}`;
        const relative = await tools.screenshot(name);
        screenshots.push(relative);
        actionLog.push(`screenshot(${relative})`);
        // The model must SEE its evidence, not just hear it was saved.
        const data = await readFile(join(opts.artifactsDir, relative));
        return {
          type: "tool_result",
          tool_use_id: call.id,
          content: [
            { type: "text", text: `Screenshot saved as ${relative}. The image follows.` },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: data.toString("base64") },
            },
          ],
        };
      }
      default:
        actionLog.push(`unknown tool ${call.name}`);
        return asText(`Unknown tool "${call.name}". Available: ${TOOL_DEFS.map((t) => t.name).join(", ")}.`);
    }
  } catch (err) {
    // Step-boundary catch: record the honest failure and hand it back.
    const message = err instanceof Error ? err.message : String(err);
    actionLog.push(`${call.name} FAILED: ${message}`);
    return asText(`Action failed: ${message}`);
  }
}

/**
 * Cap token growth: once history exceeds the window, collapse everything but
 * the most recent exchanges into one text block carrying the task and the
 * action log. Cut lands on an assistant message so no tool_result is ever
 * orphaned from its tool_use.
 */
function pruneHistory(messages: ModelMessage[], task: string, actionLog: string[]): void {
  if (messages.length <= KEEP_MESSAGES) return;
  let cut = messages.length - (KEEP_MESSAGES - 1);
  while (cut < messages.length && messages[cut]!.role !== "assistant") cut++;
  if (cut >= messages.length) return;
  const summary =
    `Task: ${task}\n\nEarlier turns were summarized to save space. Actions so far:\n` +
    actionLog.slice(-40).join("\n");
  messages.splice(0, cut, { role: "user", content: [{ type: "text", text: summary }] });
}
