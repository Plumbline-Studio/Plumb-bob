// Layer 2 — Level (procedural). "Does it match the documented system?"
//
// Executes a flow's Playscript (Matthies, 1961) step by step and flags
// divergence between the documented procedure and the built behavior. The
// parser here is the authoritative source of step numbers, actors, and action
// text — the agent only supplies per-step status/notes at execution time, so
// the report can never silently renumber or reword a step.
//
// Divergence rule: a System step whose observed behavior differs from the
// script is a *divergence*, not a failure — it surfaces the question "script
// wrong, or build wrong?" for a human. Only User-step failures and inline
// `= FAIL` conditions fail the run. Bob (out-of-band) steps are recorded as
// skipped in v1 — see the note below.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Config } from "./config.js";
import type { LevelLayer, LevelStep, Divergence, ParsedPlayscript, ParsedStep, Actor } from "./types.js";
import type { PlaywrightMcp } from "./mcp.js";
import { runAgentLoop } from "./loop.js";

const ACTORS: Actor[] = ["User", "System", "Bob"];

// ── Parser ────────────────────────────────────────────────────────────────
// Pure function, no I/O, so it is trivially unit-testable offline (the local
// first-run smoke test exercises exactly this).
export function parsePlayscript(text: string): ParsedPlayscript {
  const lines = text.split(/\r?\n/);
  let flow = "";
  const purposeParts: string[] = [];
  const steps: ParsedStep[] = [];

  let mode: "head" | "purpose" | "steps" = "head";

  for (const line of lines) {
    const trimmed = line.trim();

    const flowMatch = trimmed.match(/^PLAYSCRIPT:\s*(.+)$/i);
    if (flowMatch) {
      flow = flowMatch[1].trim();
      mode = "head";
      continue;
    }

    const purposeMatch = trimmed.match(/^Purpose:\s*(.*)$/i);
    if (purposeMatch) {
      mode = "purpose";
      if (purposeMatch[1]) purposeParts.push(purposeMatch[1].trim());
      continue;
    }

    // A numbered step line: "12. Actor  action"
    const stepMatch = line.match(/^\s*(\d+)\.\s+(\w+)\s+(.*)$/);
    if (stepMatch && ACTORS.includes(stepMatch[2] as Actor)) {
      mode = "steps";
      const action = stepMatch[3].trim();
      steps.push({
        n: Number(stepMatch[1]),
        actor: stepMatch[2] as Actor,
        action,
        declaresFail: /=\s*FAIL/i.test(action),
      });
      continue;
    }

    if (mode === "purpose") {
      if (trimmed === "") mode = "head"; // purpose ends at the first blank line
      else purposeParts.push(trimmed);
      continue;
    }

    // Continuation of the previous step's action (wrapped line, no number).
    if (mode === "steps" && trimmed !== "" && steps.length > 0) {
      const last = steps[steps.length - 1];
      last.action = `${last.action} ${trimmed}`.trim();
      last.declaresFail = last.declaresFail || /=\s*FAIL/i.test(last.action);
    }
  }

  return { flow, purpose: purposeParts.join(" ").trim(), steps };
}

// ── Executor ────────────────────────────────────────────────────────────────
interface SubmittedStep {
  n: number;
  status: "pass" | "fail" | "divergence";
  note?: string;
}
interface LevelSubmission {
  steps: SubmittedStep[];
  divergences: { step: number; question: string }[];
}

const SUBMIT_TOOL: Anthropic.Tool = {
  name: "submit_level",
  description:
    "Call this once, after executing every User and System step, to submit your results. " +
    "Report a status for each User/System step by its number. Do not report Bob steps — those are handled out of band.",
  input_schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            n: { type: "integer" },
            status: { type: "string", enum: ["pass", "fail", "divergence"] },
            note: { type: "string" },
          },
          required: ["n", "status"],
        },
      },
      divergences: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: { type: "integer" },
            question: {
              type: "string",
              description: 'Always framed as: "script wrong, or build wrong?" with the specifics.',
            },
          },
          required: ["step", "question"],
        },
      },
    },
    required: ["steps", "divergences"],
  },
};

const SYSTEM = `You are Plumb Bob's procedural-verification agent. You execute a Playscript — a numbered procedure, one actor + one action per step — against a live web app via Playwright MCP tools, in order.

Execution semantics:
- User steps: YOU perform the action in the browser. If you cannot perform it, that step is "fail".
- System steps: you VERIFY the described behavior by observing the page. If the behavior differs from what the step says, that is "divergence" (NOT fail) — unless the step declares "= FAIL", in which case a violation is "fail".
- Bob steps: out-of-band checks (database/analytics). Do NOT attempt these and do NOT report them — they are handled separately.
- The Playscript is the source of truth. When built behavior diverges, never decide who is right — record the divergence and frame the question "script wrong, or build wrong?" for a human.

Take a screenshot at decisive moments. Work through every User/System step in order, then call submit_level exactly once with a status for each User/System step and any divergences you found.`;

function loadPrimaryPlayscript(config: Config): { name: string; path: string; extra: string[] } | null {
  const names = Object.keys(config.consumer.playscripts ?? {});
  if (names.length === 0) return null;
  const primary = names[0];
  const path = join(config.playscriptDir, `${primary}.md`);
  if (!existsSync(path)) return null;
  return { name: primary, path, extra: names.slice(1) };
}

export async function runLevel(
  client: Anthropic,
  mcp: PlaywrightMcp,
  config: Config,
  log: (msg: string) => void,
): Promise<LevelLayer> {
  const primary = loadPrimaryPlayscript(config);
  if (!primary) {
    return { status: "skipped", playscript: "(none)", steps: [], divergences: [] };
  }
  if (primary.extra.length > 0) {
    log(`Level: executing "${primary.name}"; ${primary.extra.length} other playscript(s) not leveled in v1 (report holds one flow).`);
  }

  const parsed = parsePlayscript(readFileSync(primary.path, "utf8"));
  const byN = new Map(parsed.steps.map((s) => [s.n, s]));

  const route = config.consumer.playscripts[primary.name]?.route ?? "/";
  const url = new URL(route, config.previewUrl).toString();

  const scriptText = parsed.steps
    .map((s) => `${String(s.n).padStart(2, " ")}. ${s.actor}  ${s.action}`)
    .join("\n");

  const firstMessage =
    `Playscript: ${parsed.flow}\nPurpose: ${parsed.purpose}\n\n` +
    `Preview URL (start here): ${url}\n\nSteps:\n${scriptText}\n\n` +
    `Execute the User and System steps in order, then call submit_level.`;

  const tools = [...(await mcp.anthropicTools()), SUBMIT_TOOL];

  const result = await runAgentLoop<LevelSubmission>(
    client,
    config,
    SYSTEM,
    firstMessage,
    tools,
    async (name, input) => {
      if (name === "submit_level") {
        const steps = Array.isArray(input.steps) ? (input.steps as SubmittedStep[]) : [];
        const divergences = Array.isArray(input.divergences)
          ? (input.divergences as { step: number; question: string }[])
          : [];
        return { content: [{ type: "text", text: "Results recorded." }], finish: { steps, divergences } };
      }
      return mcp.call(name, input);
    },
  );

  const submitted = new Map<number, SubmittedStep>(
    (result.finished?.steps ?? []).map((s) => [s.n, s]),
  );

  const steps: LevelStep[] = parsed.steps.map((p: ParsedStep) => {
    if (p.actor === "Bob") {
      // v1 records out-of-band Bob checks as skipped-with-note. The report
      // step-status enum has no "skipped", so we use a non-failing "pass" and
      // make the skip explicit in the note (see run.schema.json).
      return {
        n: p.n,
        actor: p.actor,
        action: p.action,
        status: "pass",
        note: "SKIPPED: out-of-band Bob verification (DB/analytics) is deferred in v1.",
      };
    }
    const sub = submitted.get(p.n);
    if (!sub) {
      return { n: p.n, actor: p.actor, action: p.action, status: "fail", note: "Not reported by the agent." };
    }
    return { n: p.n, actor: p.actor, action: p.action, status: sub.status, note: sub.note };
  });

  const divergences: Divergence[] = (result.finished?.divergences ?? [])
    .filter((d) => byN.has(d.step))
    .map((d) => ({ step: d.step, question: d.question }));

  // Status precedence: any fail → fail; else any divergence → divergence; else pass.
  let status: LevelLayer["status"] = "pass";
  if (steps.some((s) => s.status === "fail")) status = "fail";
  else if (steps.some((s) => s.status === "divergence") || divergences.length > 0) status = "divergence";

  return { status, playscript: parsed.flow, steps, divergences };
}
