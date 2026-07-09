// Playwright MCP bridge.
//
// The functional (Plumb) and procedural (Level) layers drive a real browser
// against the preview deploy. We do that by running the official Playwright MCP
// server (`@playwright/mcp`) as a stdio subprocess, exposing its tools to the
// Anthropic Messages API as ordinary tool definitions, and running the agent
// loop ourselves (in plumb.ts / level.ts) so we control screenshot capture and
// step boundaries.
//
// This wrapper's job: start/stop the server, translate MCP tool schemas into
// Anthropic tool definitions, and translate MCP tool *results* into Anthropic
// tool_result content — saving any returned screenshots to disk and passing the
// image back to the model so it can actually see the page.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";

type AnthropicTool = Anthropic.Tool;
// tool_result content is narrower than a full ContentBlockParam — only these
// block kinds are legal inside a tool result. The browser tools return exactly
// text and images.
type ToolResultContent = Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

export interface CallResult {
  content: ToolResultContent;
  isError: boolean;
  // Relative paths (from outputDir) of any screenshots saved during this call.
  screenshots: string[];
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

// Join the text blocks of a tool result (ignoring images) — used for the
// console/network captures, which are text.
function textOf(content: ToolResultContent): string {
  return content
    .filter((c): c is Anthropic.TextBlockParam => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export class PlaywrightMcp {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private shotCount = 0;

  constructor(
    private readonly outputDir: string,
    private readonly screenshotDir: string,
  ) {}

  async start(): Promise<void> {
    mkdirSync(this.screenshotDir, { recursive: true });
    // --headless: CI has no display. --isolated: fresh profile per run, no
    // persisted cookies (Playscripts that need a "fresh session" depend on this).
    this.transport = new StdioClientTransport({
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      stderr: "inherit",
    });
    this.client = new Client({ name: "plumb-bob", version: "1.0.0" });
    await this.client.connect(this.transport);
  }

  async anthropicTools(): Promise<AnthropicTool[]> {
    if (!this.client) throw new Error("MCP client not started");
    const { tools } = await this.client.listTools();
    return tools.map((t) => {
      const schema = (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} };
      if (schema.type !== "object") schema.type = "object";
      return {
        name: t.name,
        description: t.description ?? `Playwright MCP tool: ${t.name}`,
        input_schema: schema as Anthropic.Tool.InputSchema,
      };
    });
  }

  async call(name: string, args: Record<string, unknown>): Promise<CallResult> {
    if (!this.client) throw new Error("MCP client not started");
    let raw;
    try {
      raw = await this.client.callTool({ name, arguments: args });
    } catch (err) {
      return {
        content: [{ type: "text", text: `Tool "${name}" threw: ${String(err)}` }],
        isError: true,
        screenshots: [],
      };
    }

    const content: ToolResultContent = [];
    const screenshots: string[] = [];
    const items = Array.isArray(raw.content) ? raw.content : [];

    for (const item of items) {
      if (item.type === "text") {
        content.push({ type: "text", text: String(item.text ?? "") });
      } else if (item.type === "image" && typeof item.data === "string") {
        const mime = String(item.mimeType ?? "image/png");
        const ext = IMAGE_EXT[mime] ?? "png";
        const file = join(this.screenshotDir, `shot-${String(++this.shotCount).padStart(3, "0")}.${ext}`);
        writeFileSync(file, Buffer.from(item.data, "base64"));
        const rel = relative(this.outputDir, file).split("\\").join("/");
        screenshots.push(rel);
        content.push({
          type: "image",
          source: { type: "base64", media_type: mime as "image/png", data: item.data },
        });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "(no content returned)" });

    return { content, isError: Boolean(raw.isError), screenshots };
  }

  // Explicitly grab a screenshot at a chosen boundary (goal/step). Best-effort:
  // if the server exposes no screenshot tool, returns null.
  async screenshot(): Promise<string | null> {
    const res = await this.call("browser_take_screenshot", {});
    return res.screenshots[0] ?? null;
  }

  // The browser's own record of what happened — the channel where a failed auth
  // redirect or a broken XHR actually shows up (a visually-fine page can still
  // be firing 4xx/5xx behind it). Used by the functional layer's error backstop.
  async networkText(): Promise<string> {
    return textOf((await this.call("browser_network_requests", {})).content);
  }
  async consoleText(): Promise<string> {
    return textOf((await this.call("browser_console_messages", {})).content);
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
    this.transport = null;
  }
}
