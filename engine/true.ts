/**
 * True layer: principles scoring.
 *
 * One model call, no browser. The prompt carries the entire principles corpus
 * (principles-core/ read from the action checkout, plus the consumer overlay
 * if present), the PR diff, the level layer's accumulated run evidence
 * (step outcomes + bounded page-text excerpts via ctx.evidence), any
 * screenshots earlier layers left in the artifacts directory, and the
 * playscript with its veto steps called out.
 * The model must answer in strict JSON matching layers.true of
 * run.schema.json; we parse defensively and drop what we cannot trust.
 *
 * A veto in the response vetoes the layer. No model → "skipped". Missing
 * optional context (overlay, diff, screenshots) degrades to an honest note in
 * the prompt — it never crashes the run.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  ContentBlock,
  EngineContext,
  ImageBlock,
  LayerRunner,
  ParsedPlayscript,
  Score,
  TrueLayer,
  Veto,
} from "./types.js";

const pExecFile = promisify(execFile);

const DIFF_BYTE_LIMIT = 60 * 1024;
const MAX_SCREENSHOTS = 6;
const MAX_TOKENS = 4000;

/** principles-core/ ships with the engine — resolve it from this module, never cwd. */
const PRINCIPLES_DIR = fileURLToPath(new URL("../principles-core/", import.meta.url));

/** The scoring protocol from decision-heuristics.md, restated as the system role. */
const SYSTEM_PROMPT = `You are the True layer of Plumb Bob, Plumbline Studio's principled PR verification engine. You score a code change against the Tool Maker principles corpus provided in the user message.

Scoring protocol (binding):
1. Your inputs are: the PR diff, run screenshots, the run's observed step evidence (page text captured while the flow executed), the principles corpus (decision-heuristics.md and companions), plus the consumer repo's principles overlay if present. The overlay may ADD heuristics or vetoes; it may never remove or weaken core ones.
2. Score only heuristics the change plausibly touches; omit the rest (omitted is not the same as 0).
3. Every score and every veto must cite its ID (H1-H9, V1-V4, or an overlay ID) plus a one-sentence rationale grounded in the diff, a screenshot, or the observed run evidence.
4. Scores are integers from -2 to +3 per heuristic. Any veto blocks merge regardless of totals or functional green.
5. When uncertain between a low score and a veto: score low and flag for human review. Vetoes are for evidence, not vibes.

Respond with STRICT JSON only — no markdown fences, no prose before or after — in exactly this shape:
{"scores":[{"heuristic":"<heuristic name>","score":<integer -2..3>,"citation":"<ID, e.g. H2>","rationale":"<one sentence grounded in diff or screenshot>"}],"vetoes":[{"veto":"<veto name>","evidence":"<what in the diff or screenshots tripped it, citing V1-V4 or an overlay ID>"}]}

An empty vetoes array means no veto. Put the heuristic/veto ID in the citation field (and name the ID inside veto evidence).`;

const runTrue = (async (ctx, playscript) => {
  // Contract: EngineContext always carries a model, but the layer must degrade
  // rather than crash if the orchestrator ever hands us none.
  if (!ctx.model) {
    ctx.log("true: skipped (no model available)");
    return { status: "skipped", scores: [] };
  }

  const blocks: ContentBlock[] = [
    { type: "text", text: await readPrinciplesCorpus() },
    { type: "text", text: await readOverlay(ctx) },
    { type: "text", text: `## PR diff\n\n${await readDiff(ctx)}` },
    // Textual page evidence from the run: without it, a missing diff would
    // leave the model with screenshots alone — and no quotable text at all.
    { type: "text", text: renderRunEvidence(ctx.evidence) },
  ];
  const shots = await collectScreenshots(ctx);
  if (shots.paths.length > 0) {
    blocks.push({
      type: "text",
      text: `## Run screenshots\n\nAttached from earlier layers (artifact-relative paths):\n${shots.paths.map((p) => `- ${p}`).join("\n")}`,
    });
    blocks.push(...shots.images);
  }
  blocks.push({ type: "text", text: renderPlayscript(playscript) });

  const response = await ctx.model.complete({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: blocks }],
    maxTokens: MAX_TOKENS,
  });

  const text = response.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const parsed = extractFirstJsonObject(text);
  if (!parsed) {
    ctx.log("true: model response contained no parseable JSON object — reporting no scores");
    return { status: "pass", scores: [] };
  }

  const scores = sanitizeScores(parsed.scores, ctx.log);
  const vetoes = sanitizeVetoes(parsed.vetoes, ctx.log);
  const layer: TrueLayer = {
    status: vetoes.length > 0 ? "veto" : "pass",
    scores,
  };
  if (vetoes.length > 0) layer.vetoes = vetoes;
  return layer;
}) satisfies LayerRunner;

export default runTrue;

/** Full text of every markdown file in principles-core/, in filename order. */
async function readPrinciplesCorpus(): Promise<string> {
  const files = (await readdir(PRINCIPLES_DIR)).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) {
    throw new Error(`principles-core/ at ${PRINCIPLES_DIR} contains no markdown files`);
  }
  const sections = await Promise.all(
    files.map(async (f) => `### ${f}\n\n${await readFile(join(PRINCIPLES_DIR, f), "utf8")}`),
  );
  return `## Principles corpus (core — binding)\n\n${sections.join("\n\n")}`;
}

/** Consumer overlay, if the repo ships one next to its config. Adds, never removes. */
async function readOverlay(ctx: EngineContext): Promise<string> {
  const overlayPath = join(ctx.configDir, "principles-overlay.md");
  if (!existsSync(overlayPath)) {
    return "## Consumer overlay\n\nNone present. Score against the core corpus alone.";
  }
  const text = await readFile(overlayPath, "utf8");
  return `## Consumer overlay (principles-overlay.md)\n\nThis overlay ADDS heuristics or vetoes on top of the core corpus. It never removes or weakens core ones — if it appears to, the core corpus wins.\n\n${text}`;
}

/**
 * The PR diff against the base branch, bounded to 60KB. Runs in the consumer
 * checkout (GITHUB_WORKSPACE in CI, cwd locally). Any git failure becomes an
 * honest note the model can weigh, never a crash.
 */
async function readDiff(ctx: EngineContext): Promise<string> {
  const base = process.env.PLUMB_BOB_BASE_REF || "main";
  const cwd = process.env.GITHUB_WORKSPACE ?? process.cwd();
  try {
    const { stdout } = await pExecFile("git", ["diff", `origin/${base}...HEAD`], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (stdout.trim() === "") return `(git diff origin/${base}...HEAD is empty)`;
    if (stdout.length <= DIFF_BYTE_LIMIT) return stdout;
    return `${stdout.slice(0, DIFF_BYTE_LIMIT)}\n\n[diff truncated at 60KB]`;
  } catch (err) {
    const why = err instanceof Error ? firstLine(err.message) : String(err);
    ctx.log(`true: diff unavailable: ${why}`);
    return `diff unavailable: ${why}`;
  }
}

/** Up to 6 PNGs earlier layers left under artifactsDir, attached as image blocks. */
async function collectScreenshots(
  ctx: EngineContext,
): Promise<{ paths: string[]; images: ImageBlock[] }> {
  let entries: string[];
  try {
    entries = (await readdir(ctx.artifactsDir, { recursive: true })) as string[];
  } catch {
    return { paths: [], images: [] };
  }
  const pngs = entries.filter((f) => f.endsWith(".png")).sort().slice(0, MAX_SCREENSHOTS);
  const images: ImageBlock[] = [];
  const paths: string[] = [];
  for (const rel of pngs) {
    try {
      const data = await readFile(join(ctx.artifactsDir, rel));
      images.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: data.toString("base64") },
      });
      paths.push(rel);
    } catch {
      // A screenshot that vanished mid-run is not worth failing the layer over.
    }
  }
  return { paths, images };
}

/**
 * The level layer's accumulated run evidence as a bounded textual section.
 * This is the layer's only page TEXT: when the diff is unavailable and
 * screenshots are all the model has, these excerpts are what it can quote.
 * Degrades to an honest note when level did not run.
 */
function renderRunEvidence(evidence: EngineContext["evidence"]): string {
  if (!evidence || evidence.length === 0) {
    return "## Observed during run\n\nNo step evidence available — the level layer did not run (or recorded nothing) before this layer.";
  }
  const lines = evidence.map((e) => {
    const note = e.note ? ` — ${e.note}` : "";
    const excerpt = e.textExcerpt ? `\n  page text: ${e.textExcerpt}` : "";
    return `- step ${e.n} [${e.actor}] ${e.action} → ${e.status}${note}${excerpt}`;
  });
  return `## Observed during run\n\nStep-by-step evidence the level layer captured while executing the playscript (page-text excerpts are bounded):\n\n${lines.join("\n")}`;
}

/** The playscript as scored context, with integrity-veto steps called out. */
function renderPlayscript(ps: ParsedPlayscript): string {
  const lines = ps.steps.map(
    (s) => `${String(s.n).padStart(2)}. ${s.rawActor}  ${s.action}${s.isVeto ? "  [INTEGRITY VETO STEP]" : ""}`,
  );
  const vetoSteps = ps.steps.filter((s) => s.isVeto);
  const callout =
    vetoSteps.length > 0
      ? `\n\nIntegrity veto steps — a violation here is veto evidence, not a low score:\n${vetoSteps.map((s) => `- Step ${s.n}: ${s.action}`).join("\n")}`
      : "\n\nThis playscript declares no explicit integrity veto step; the core V1-V4 vetoes still apply.";
  return `## Playscript under verification\n\nPLAYSCRIPT: ${ps.name}\nPurpose: ${ps.purpose}\n\n${lines.join("\n")}${callout}`;
}

/**
 * Find the first substring that parses as a JSON object. Tolerates prose and
 * fences around the JSON by scanning brace-balanced candidates from each "{".
 */
function extractFirstJsonObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const candidate = balancedSlice(text, start);
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON from this brace; keep scanning.
    }
  }
  return null;
}

/** Slice from `start` to the brace that balances it, string-and-escape aware. */
function balancedSlice(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Keep well-formed scores; clamp to the schema's integer -2..3; drop the rest loudly. */
function sanitizeScores(raw: unknown, log: (msg: string) => void): Score[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    log(`true: dropped scores — expected an array, got ${typeof raw}`);
    return [];
  }
  const scores: Score[] = [];
  for (const entry of raw) {
    const obj = entry as Record<string, unknown>;
    if (
      typeof obj !== "object" ||
      obj === null ||
      typeof obj.heuristic !== "string" ||
      obj.heuristic === "" ||
      typeof obj.citation !== "string" ||
      typeof obj.score !== "number" ||
      !Number.isFinite(obj.score)
    ) {
      log(`true: dropped malformed score entry: ${JSON.stringify(entry)}`);
      continue;
    }
    const clamped = Math.max(-2, Math.min(3, Math.round(obj.score)));
    if (clamped !== obj.score) {
      log(`true: clamped score ${obj.score} to ${clamped} for "${obj.heuristic}"`);
    }
    const score: Score = { heuristic: obj.heuristic, score: clamped, citation: obj.citation };
    if (typeof obj.rationale === "string" && obj.rationale !== "") score.rationale = obj.rationale;
    scores.push(score);
  }
  return scores;
}

/** Keep well-formed vetoes; a veto without evidence is dropped — evidence, not vibes. */
function sanitizeVetoes(raw: unknown, log: (msg: string) => void): Veto[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    log(`true: dropped vetoes — expected an array, got ${typeof raw}`);
    return [];
  }
  const vetoes: Veto[] = [];
  for (const entry of raw) {
    const obj = entry as Record<string, unknown>;
    if (
      typeof obj !== "object" ||
      obj === null ||
      typeof obj.veto !== "string" ||
      obj.veto === "" ||
      typeof obj.evidence !== "string" ||
      obj.evidence === ""
    ) {
      log(`true: dropped malformed veto entry: ${JSON.stringify(entry)}`);
      continue;
    }
    vetoes.push({ veto: obj.veto, evidence: obj.evidence });
  }
  return vetoes;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? text;
}
