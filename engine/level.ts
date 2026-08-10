/**
 * Level layer: playscript execution per the spec's semantics
 * (schema/playscript.spec.md).
 *
 * One fresh visitor walks the flow's route, then steps run strictly in
 * order: User steps are performed by a tightly-scoped agent (inability =
 * fail, and the walk stops — later steps are unreachable); System steps are
 * verified against the live page (mismatch = divergence, unless the script
 * declared `= FAIL`); Bob steps are skipped in v1 (no integrations wired);
 * veto steps verify the never-condition stayed never.
 *
 * Every divergence carries the Matthies question — script wrong, or build
 * wrong? — because divergence is a question for a human, not a verdict.
 */

import { runAgentTask } from "./agent-loop.js";
import { BrowserSession } from "./browser/session.js";
import { createBrowserTools } from "./browser/tools.js";
import type {
  BrowserTools,
  DivergenceRecord,
  EngineContext,
  LevelLayer,
  ParsedPlayscript,
  ParsedStep,
  StepEvidence,
  StepResult,
} from "./types.js";

const USER_STEP_MAX_TURNS = 8;
const VERIFY_STEP_MAX_TURNS = 6;
/** Keep the Matthies question readable — the full reasoning lives in the step note. */
const OBSERVED_SUMMARY_CAP = 200;
/** Bound on each per-step visible-text excerpt carried as run evidence. */
const EVIDENCE_EXCERPT_CAP = 600;

const USER_PREAMBLE = [
  "You are executing exactly one step of a procedural script in a real browser.",
  "Perform only the action described — nothing more, no exploring ahead.",
  "If the page seems unchanged after your action, you may use the wait tool and read_page again before concluding it did not change.",
  "If you complete the action, call finish with outcome success.",
  "If you genuinely cannot perform it, call finish with outcome failure and say honestly what blocked you.",
].join(" ");

const VERIFY_PREAMBLE = [
  "You are verifying one expected system behavior against the current page state.",
  "Gather evidence with read_page and screenshot; do not click, type, or navigate — observation only.",
  "If the expected state has not appeared yet, you may use the wait tool and read_page again before concluding the page does not show it.",
  "Call finish with outcome success only if the page genuinely shows the described behavior;",
  "otherwise outcome failure, with reasoning that states exactly what you observed instead.",
].join(" ");

const VETO_PREAMBLE = [
  "You are auditing that a condition the script declares must NEVER occur stayed absent for this entire run.",
  "Gather evidence with read_page and screenshot; you may also re-read the page and navigate back to pages this run already visited to check them.",
  "Do not advance the flow with new actions — no form submissions, no fresh orders.",
  "If the page seems unchanged after re-reading, you may use the wait tool and read_page again before concluding it did not change.",
  "Call finish with outcome success only if the never-condition was NOT observed anywhere in the run;",
  "otherwise outcome failure, with reasoning quoting exactly where you observed it.",
].join(" ");

const runLevel = async (
  ctx: EngineContext,
  playscript: ParsedPlayscript,
): Promise<LevelLayer> => {
  const session = new BrowserSession();
  await session.launch();
  try {
    const tools = createBrowserTools(session, ctx.artifactsDir);
    await tools.freshContext();
    await tools.navigate(startUrl(ctx, playscript));

    const steps: StepResult[] = [];
    const divergences: DivergenceRecord[] = [];
    // Run evidence accumulates on the shared context so the veto step (below)
    // and the True layer (which runs after us) can judge from what this run
    // actually observed, not just the final page.
    const evidence: StepEvidence[] = (ctx.evidence ??= []);
    let halted = false;

    for (const step of playscript.steps) {
      if (halted) {
        const skippedResult = stepResult(step, "skipped", "not reached");
        steps.push(skippedResult);
        evidence.push(evidenceFor(skippedResult));
        continue;
      }
      const result = await executeStep(ctx, tools, step, evidence);
      if (ctx.config.agent.screenshot_every_step && result.status !== "skipped") {
        await attachStepScreenshot(tools, result, step.n);
      }
      steps.push(result);
      evidence.push(
        evidenceFor(result, result.status === "skipped" ? undefined : await captureExcerpt(tools)),
      );
      if (result.status === "divergence") {
        divergences.push({
          step: step.n,
          question:
            `Step ${step.n}: expected "${step.action}" — observed ` +
            `${summarizeObservation(result.note)}. Script wrong, or build wrong?`,
        });
      }
      // A User step the agent could not perform makes the rest of the script
      // unreachable; verification steps (even failed ones) do not.
      if (result.status === "fail" && step.actor === "User" && !step.isVeto) halted = true;
    }

    const status = steps.some((s) => s.status === "fail")
      ? "fail"
      : divergences.length > 0
        ? "divergence"
        : "pass";
    return {
      status,
      playscript: playscript.file,
      steps,
      ...(divergences.length > 0 ? { divergences } : {}),
    };
  } finally {
    await session.close();
  }
};

async function executeStep(
  ctx: EngineContext,
  tools: BrowserTools,
  step: ParsedStep,
  evidence: StepEvidence[],
): Promise<StepResult> {
  // Veto steps outrank actor semantics: verify the never-condition was NOT
  // observed this run, whatever actor declared it. The auditor gets the
  // accumulated run log — it cannot judge "during this run" from the final
  // page alone.
  if (step.isVeto) {
    const task = await runAgentTask({
      model: ctx.model,
      tools,
      task:
        `Integrity check. The script declares a condition that must NEVER occur: "${step.action}". ` +
        "Verify that this never-condition was NOT observed at any point during this run — " +
        "check the run log below and the current page (you may revisit pages from the flow). " +
        "finish success if the invariant held; finish failure if you observed the condition occur.\n\n" +
        renderRunLog(evidence),
      systemPreamble: VETO_PREAMBLE,
      maxTurns: VERIFY_STEP_MAX_TURNS,
      screenshotPrefix: `level-step-${step.n}`,
      artifactsDir: ctx.artifactsDir,
    });
    if (task.outcome === "success") return stepResult(step, "pass", task.reasoning);
    return stepResult(step, "fail", `integrity veto violated: ${task.reasoning}`);
  }

  if (step.actor === "Bob") {
    return stepResult(step, "skipped", "integration not configured (v1)");
  }

  if (step.actor === "User") {
    ctx.log(`level: step ${step.n} (User): ${step.action}`);
    const task = await runAgentTask({
      model: ctx.model,
      tools,
      task: `Perform this single action on the current page: ${step.action}`,
      systemPreamble: USER_PREAMBLE,
      maxTurns: USER_STEP_MAX_TURNS,
      screenshotPrefix: `level-step-${step.n}`,
      artifactsDir: ctx.artifactsDir,
    });
    return stepResult(step, task.outcome === "success" ? "pass" : "fail", task.reasoning);
  }

  // System (including named external parties mapped to System): verify.
  ctx.log(`level: step ${step.n} (${step.rawActor}): ${step.action}`);
  const task = await runAgentTask({
    model: ctx.model,
    tools,
    task: `Verify this expected behavior against the current page: ${step.action}`,
    systemPreamble: VERIFY_PREAMBLE,
    maxTurns: VERIFY_STEP_MAX_TURNS,
    screenshotPrefix: `level-step-${step.n}`,
    artifactsDir: ctx.artifactsDir,
  });
  if (task.outcome === "success") return stepResult(step, "pass", task.reasoning);
  // Mismatch is a divergence — a question, not a verdict — unless the script
  // declared this condition a hard failure inline.
  return stepResult(step, step.hardFail ? "fail" : "divergence", task.reasoning);
}

function stepResult(
  step: ParsedStep,
  status: StepResult["status"],
  note: string,
): StepResult {
  // Named external parties survive the System mapping via the note.
  const actorNote = step.rawActor !== step.actor ? `[${step.rawActor}] ` : "";
  const fullNote = `${actorNote}${note}`.trim();
  return {
    n: step.n,
    actor: step.actor,
    action: step.action,
    status,
    ...(fullNote ? { note: fullNote } : {}),
  };
}

/** StepResult → StepEvidence, with an optional bounded page-text excerpt. */
function evidenceFor(result: StepResult, textExcerpt?: string): StepEvidence {
  return {
    n: result.n,
    actor: result.actor,
    action: result.action,
    status: result.status,
    ...(result.note !== undefined ? { note: result.note } : {}),
    ...(textExcerpt !== undefined && textExcerpt !== "" ? { textExcerpt } : {}),
  };
}

/** Visible text right after a step, bounded; a failed capture is no evidence, not an error. */
async function captureExcerpt(tools: BrowserTools): Promise<string | undefined> {
  try {
    const snapshot = await tools.readPage();
    return snapshot.visibleText.slice(0, EVIDENCE_EXCERPT_CAP);
  } catch {
    return undefined;
  }
}

/** The run so far, written for the veto auditor: what each step did and saw. */
function renderRunLog(evidence: StepEvidence[]): string {
  if (evidence.length === 0) return "Run log: no earlier steps ran before this check.";
  const lines = evidence.map((e) => {
    const note = e.note ? ` — ${e.note}` : "";
    const excerpt = e.textExcerpt ? ` | page text: ${e.textExcerpt}` : "";
    return `${e.n}. [${e.actor}] ${e.action} → ${e.status}${note}${excerpt}`;
  });
  return `Run log (everything this run observed, step by step):\n${lines.join("\n")}`;
}

/** Evidence screenshot per executed step; a capture failure is recorded, not fatal. */
async function attachStepScreenshot(
  tools: BrowserTools,
  result: StepResult,
  n: number,
): Promise<void> {
  try {
    result.screenshot = await tools.screenshot(`level-step-${n}-after`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.note = `${result.note ? `${result.note} ` : ""}(step screenshot failed: ${message})`;
  }
}

function summarizeObservation(note: string | undefined): string {
  // Trailing periods drop so the question's own punctuation reads cleanly.
  const text = (note ?? "").replace(/\s+/g, " ").trim().replace(/\.+$/, "");
  if (!text) return "behavior that did not match";
  return text.length > OBSERVED_SUMMARY_CAP ? `${text.slice(0, OBSERVED_SUMMARY_CAP)}…` : text;
}

function startUrl(ctx: EngineContext, playscript: ParsedPlayscript): string {
  const flow = playscript.file.replace(/\.playscript\.md$/, "").replace(/\.md$/, "");
  const route = ctx.config.playscripts[flow]?.route ?? "";
  if (!route || route === "/") return ctx.previewUrl;
  return new URL(route, ctx.previewUrl).href;
}

export default runLevel;
