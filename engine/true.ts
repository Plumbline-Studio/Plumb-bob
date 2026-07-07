// Layer 3 — True (principled). "Should it exist this way?"
//
// A single, no-browser Anthropic call that scores the diff + run screenshots
// against the Plumbline principles corpus (principles-core/) plus any consumer
// overlay. Each heuristic scores -2..+3 with a required citation; any integrity
// veto blocks merge regardless of functional green.
//
// The scoring protocol lives in principles-core/decision-heuristics.md — we
// feed that file (and the rest of the corpus) in verbatim rather than
// hard-coding the rubric here, so the corpus stays the single source of truth.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { TrueLayer, TrueScore, TrueVeto } from "./types.js";

// Mirrors layers.true in run.schema.json, minus the numeric range (structured
// outputs can't express minimum/maximum — we clamp after).
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heuristic: { type: "string" },
          score: { type: "integer" },
          citation: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["heuristic", "score", "citation", "rationale"],
        additionalProperties: false,
      },
    },
    vetoes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          veto: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["veto", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["scores", "vetoes"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

function loadPrinciples(config: Config): string {
  const parts: string[] = [];
  if (existsSync(config.principlesDir)) {
    for (const file of readdirSync(config.principlesDir).sort()) {
      if (file.endsWith(".md")) {
        parts.push(`### principles-core/${file}\n\n${readFileSync(join(config.principlesDir, file), "utf8")}`);
      }
    }
  }
  if (config.overlayPath) {
    parts.push(`### consumer overlay (${config.overlayPath})\n\n${readFileSync(config.overlayPath, "utf8")}`);
  }
  return parts.join("\n\n---\n\n");
}

function screenshotBlocks(config: Config, screenshots: string[]): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const rel of screenshots.slice(0, 6)) {
    const abs = join(config.outputDir, rel);
    if (!existsSync(abs)) continue;
    const data = readFileSync(abs).toString("base64");
    const media = rel.endsWith(".jpg") || rel.endsWith(".jpeg") ? "image/jpeg" : "image/png";
    blocks.push({ type: "image", source: { type: "base64", media_type: media as "image/png", data } });
  }
  return blocks;
}

const SYSTEM = `You are Plumb Bob's principled-review agent. You score a code change against the Plumbline principles corpus provided below. Follow the scoring protocol in decision-heuristics.md exactly:

- Score ONLY the heuristics the change plausibly touches; omit the rest (an omitted heuristic is not a zero).
- Each score is an integer from -2 to +3 and MUST cite the principle ID (e.g. "H2", "V1") that drove it, plus a one-sentence rationale grounded in the diff or a screenshot.
- Raise a veto ONLY with concrete evidence from the diff or a screenshot. When uncertain between a low score and a veto, score low and note it — vetoes are for evidence, not vibes.
- A consumer overlay may ADD heuristics or vetoes; it may never remove core ones.

Return your assessment in the required structured format.`;

export async function runTrue(
  client: Anthropic,
  config: Config,
  diff: string,
  diffNote: string,
  screenshots: string[],
): Promise<TrueLayer> {
  const principles = loadPrinciples(config);

  const userContent: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        `# Plumbline principles corpus\n\n${principles}\n\n` +
        `# The change under review\n\nDiff source: ${diffNote}\n\n\`\`\`diff\n${diff || "(no diff available)"}\n\`\`\`\n\n` +
        (screenshots.length
          ? `# Run screenshots\n\nBelow are ${Math.min(screenshots.length, 6)} screenshot(s) captured during functional/procedural testing. Use them as evidence where relevant.`
          : `# Run screenshots\n\n(none captured)`),
    },
    ...screenshotBlocks(config, screenshots),
  ];

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    output_config: { effort: config.effort, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "{}";
  let parsed: { scores?: TrueScore[]; vetoes?: TrueVeto[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { scores: [], vetoes: [] };
  }

  const scores: TrueScore[] = (parsed.scores ?? []).map((s) => ({
    heuristic: String(s.heuristic ?? ""),
    score: Math.max(-2, Math.min(3, Math.round(Number(s.score) || 0))), // clamp to schema range
    citation: String(s.citation ?? ""),
    rationale: s.rationale ? String(s.rationale) : undefined,
  }));
  const vetoes: TrueVeto[] = (parsed.vetoes ?? []).map((v) => ({
    veto: String(v.veto ?? ""),
    evidence: String(v.evidence ?? ""),
  }));

  // Any veto blocks merge, regardless of scores.
  const status: TrueLayer["status"] = vetoes.length > 0 ? "veto" : "pass";
  return { status, scores, vetoes };
}
