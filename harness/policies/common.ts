/**
 * Shared brains for the mock-tier policies: a scripted-but-competent QA agent
 * for the Lantern Supply Co. fixtures.
 *
 * The load-bearing rule: policies never hardcode verdicts. Every finish()
 * outcome is derived from what read_page actually returned, so the fixture —
 * not the policy — decides whether a run passes, fails, diverges, or vetoes.
 * That is what makes the mock tier an eval of the engine's machinery instead
 * of a tautology.
 *
 * The engine's layer prompts and tool schemas are owned by another module
 * (engine/plumb.ts, engine/level.ts, engine/true.ts), so everything here is
 * defensive about names: tools are located by regex over req.tools, input
 * keys are picked from each tool's input_schema, and the current task is
 * taken as the last plain-text user message. If a layer's vocabulary drifts,
 * this file is the single place to re-aim the policies.
 */

import type {
  ContentBlock,
  ModelRequest,
  ModelResponse,
  ToolDef,
  ToolUseBlock,
} from "../../engine/types.js";

/** The contract engine/model/mock.ts's MockModelClient wraps. */
export type PolicyFn = (req: ModelRequest, state: { turn: number }) => ModelResponse;

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

let nextId = 0;

export function toolCall(
  name: string,
  input: Record<string, unknown>,
  narration?: string,
): ModelResponse {
  const content: ContentBlock[] = [];
  if (narration) content.push({ type: "text", text: narration });
  content.push({ type: "tool_use", id: `mock_${++nextId}`, name, input });
  return { content, stopReason: "tool_use" };
}

export function textResponse(text: string): ModelResponse {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

// ---------------------------------------------------------------------------
// Request introspection
// ---------------------------------------------------------------------------

function blockText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) =>
      b.type === "text" ? b.text : b.type === "tool_result" ? blockText(b.content) : "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Every piece of text the model can currently "see" (system + full history). */
function requestText(req: ModelRequest): string {
  return [req.system, ...req.messages.map((m) => blockText(m.content))].join("\n");
}

function findTool(req: ModelRequest, re: RegExp): ToolDef | undefined {
  return (req.tools ?? []).find((t) => re.test(t.name));
}

function schemaProps(tool: ToolDef | undefined): Record<string, unknown> {
  const props = tool?.input_schema["properties"];
  return typeof props === "object" && props !== null
    ? (props as Record<string, unknown>)
    : {};
}

/** Choose the tool-input key the layer actually declared (first match wins). */
function pickKey(tool: ToolDef | undefined, candidates: string[], fallback: string): string {
  const props = schemaProps(tool);
  return candidates.find((c) => c in props) ?? fallback;
}

/**
 * The conversation slice since the layer last spoke to the agent in plain
 * text: that text is the current task (a playscript step or a plumb goal);
 * actions are the agent's tool calls since then; snapshots are the read-page
 * results that came back.
 */
interface Episode {
  task: string;
  actions: ToolUseBlock[];
  snapshots: string[];
}

function currentEpisode(req: ModelRequest, readToolName: string): Episode {
  let start = 0;
  let task = "";
  req.messages.forEach((m, i) => {
    if (m.role === "user" && m.content.some((b) => b.type === "text")) {
      start = i;
      task = m.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
  });
  const actions: ToolUseBlock[] = [];
  const snapshots: string[] = [];
  const toolNameById = new Map<string, string>();
  for (const m of req.messages.slice(start)) {
    for (const b of m.content) {
      if (b.type === "tool_use") {
        actions.push(b);
        toolNameById.set(b.id, b.name);
      }
      if (b.type === "tool_result" && toolNameById.get(b.tool_use_id) === readToolName) {
        snapshots.push(blockText(b.content));
      }
    }
  }
  return { task, actions, snapshots };
}

function excerpt(text: string, max = 400): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * A readable quote around a match. Page snapshots arrive as single-line JSON,
 * so "the line containing the match" would be the whole snapshot; a bounded
 * window keeps veto evidence quotable in a report.
 */
function quoteAround(text: string, index: number, radius = 90): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  const core = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${core}${end < text.length ? "…" : ""}`;
}

/** First absolute URL anywhere in the request — the preview URL the engine names. */
function baseUrl(req: ModelRequest): string | undefined {
  return /https?:\/\/[^\s"'<>)\]]+/.exec(requestText(req))?.[0];
}

// ---------------------------------------------------------------------------
// Finishing honestly
// ---------------------------------------------------------------------------

/**
 * Report the episode's outcome through whatever finish-shaped tool the layer
 * offers, adapting the outcome value to the tool's declared schema (enum,
 * boolean, or free string). With no finish tool, fall back to a parseable
 * text verdict.
 */
function finishCall(req: ModelRequest, ok: boolean, reason: string): ModelResponse {
  const tool = findTool(req, /finish|done|complete|conclude|verdict|report/i);
  if (!tool) return textResponse(`VERDICT: ${ok ? "success" : "failure"}\n${reason}`);
  const outcomeKey = pickKey(tool, ["outcome", "status", "result", "verdict", "success", "passed"], "outcome");
  const reasonKey = pickKey(tool, ["reason", "reasoning", "note", "summary", "details", "observation"], "reason");
  const outcomeSchema = schemaProps(tool)[outcomeKey] as Record<string, unknown> | undefined;
  let outcomeValue: unknown = ok ? "success" : "failure";
  if (outcomeSchema?.["type"] === "boolean") outcomeValue = ok;
  const allowed = outcomeSchema?.["enum"];
  if (Array.isArray(allowed)) {
    const want = ok ? /pass|success|ok|yes|true|met/i : /fail|mismatch|no|unmet/i;
    const hit = allowed.find((v) => typeof v === "string" && want.test(v));
    if (hit !== undefined) outcomeValue = hit;
  }
  return toolCall(tool.name, { [outcomeKey]: outcomeValue, [reasonKey]: reason });
}

// ---------------------------------------------------------------------------
// True-layer scoring (no browser tools offered)
// ---------------------------------------------------------------------------

/** Manufactured urgency / fake social proof, e.g. "Only 2 left … 11 people viewing". */
const URGENCY_RE = /only\s+\d+\s+left|\d+\s+people\s+(?:are\s+)?viewing/i;
/** A recurring charge surfacing anywhere the user never chose one, e.g. "$4.99/mo". */
const RECURRING_RE = /\$\s*\d+(?:\.\d{2})?\s*\/\s*mo/i;

/**
 * Principles verdict for the True layer, derived ONLY from evidence: the
 * request text plus the page text this run's browsing actually gathered
 * (`runEvidence` — the True layer's own request carries screenshots as
 * images a scripted policy cannot read, so the accumulated read_page text
 * stands in for what a real model would see in those screenshots).
 * A clean run scores modestly positive; dark-pattern markers veto with the
 * offending line quoted as evidence.
 */
export function principlesResponse(req: ModelRequest, runEvidence = ""): ModelResponse {
  const seen = `${requestText(req)}\n${runEvidence}`;
  const urgency = URGENCY_RE.exec(seen);
  const recurring = RECURRING_RE.exec(seen);
  const vetoes: { veto: string; evidence: string }[] = [];
  if (urgency) {
    vetoes.push({
      veto: "V1 Dark patterns — manufactured urgency / fake social proof",
      evidence: quoteAround(seen, urgency.index),
    });
  }
  if (recurring) {
    vetoes.push({
      veto: "V3 Dishonest framing — recurring charge the user did not explicitly choose",
      evidence: quoteAround(seen, recurring.index),
    });
  }
  const verdict =
    vetoes.length > 0
      ? {
          status: "veto" as const,
          scores: [
            {
              heuristic: "H6",
              score: -2,
              citation: "principles-core/decision-heuristics.md H6 (earned trust)",
              rationale: "The confirmation page manipulates the user instead of informing them.",
            },
          ],
          vetoes,
        }
      : {
          status: "pass" as const,
          scores: [
            {
              heuristic: "H7",
              score: 2,
              citation: "principles-core/decision-heuristics.md H7 (clarity)",
              rationale: "The order flow states item, quantity, and total plainly; nothing needs explaining.",
            },
            {
              heuristic: "H8",
              score: 2,
              citation: "principles-core/decision-heuristics.md H8 (borrowed resources)",
              rationale: "No upsells, interstitials, or pressure spend the user's attention.",
            },
          ],
          vetoes,
        };
  // Prefer a structured tool if the True layer offers one; else JSON as text.
  const structured = (req.tools ?? []).find((t) => {
    const props = schemaProps(t);
    return "vetoes" in props || "scores" in props;
  });
  if (structured) {
    return toolCall(structured.name, {
      status: verdict.status,
      scores: verdict.scores,
      vetoes: verdict.vetoes,
    });
  }
  return textResponse(JSON.stringify(verdict, null, 2));
}

// ---------------------------------------------------------------------------
// The Lantern QA agent
// ---------------------------------------------------------------------------

export interface LanternPolicyOptions {
  /** Name typed into the order form; per-variant names make traces readable. */
  shopperName?: string;
}

/**
 * A competent scripted QA agent for the Lantern order flow, shared by all
 * four variants. It reads the page after every action, recognizes the four
 * page states (catalog / order form / newsletter interstitial / confirmation),
 * performs the current task, and finishes with whatever the page actually
 * showed — including dismissing an unexpected-but-dismissible interstitial,
 * which is exactly what a human tester would do before reporting divergence.
 */
export function makeLanternPolicy(opts: LanternPolicyOptions = {}): PolicyFn {
  const shopper = opts.shopperName ?? "Avery Tester";
  // Run-scoped evidence: every tool result the "model" has been shown this
  // run (page snapshots above all). The integrity-veto step and the True
  // layer both judge from this record — what the run actually observed —
  // never from anything this file asserts. Build one policy per engine run
  // so evidence can never leak across runs.
  const seenEvidence = new Set<string>();

  return (req, _state) => {
    for (const m of req.messages) {
      for (const b of m.content) {
        if (b.type === "tool_result") seenEvidence.add(blockText(b.content));
      }
    }
    const runEvidence = [...seenEvidence].join("\n");

    const readTool = findTool(req, /read|snapshot|observe|look|page/i);
    // No way to see a page: this is the True layer asking for a principles verdict.
    if (!readTool) return principlesResponse(req, runEvidence);

    const clickTool = findTool(req, /click|tap/i);
    const typeTool = findTool(req, /type|fill|input/i);
    const navTool = findTool(req, /nav|goto|open_url|visit/i);
    const shotTool = findTool(req, /screenshot|capture/i);
    const waitTool = findTool(req, /^wait|wait_for|settle/i);

    const ep = currentEpisode(req, readTool.name);
    const snap = ep.snapshots.at(-1) ?? "";
    const last = ep.actions.at(-1);

    const targetKeys = ["target", "selector", "element", "description", "locator"];
    const clickTarget = (desc: string): ModelResponse =>
      toolCall(clickTool!.name, { [pickKey(clickTool, targetKeys, "target")]: desc }, `Clicking ${desc}.`);
    const typeInto = (desc: string, text: string): ModelResponse =>
      toolCall(
        typeTool!.name,
        {
          [pickKey(typeTool, targetKeys, "target")]: desc,
          [pickKey(typeTool, ["text", "value", "input", "content"], "text")]: text,
        },
        `Typing "${text}" into ${desc}.`,
      );
    const takeShot = (name: string): ModelResponse =>
      toolCall(shotTool!.name, { [pickKey(shotTool, ["name", "label", "filename"], "name")]: name }, "Capturing a screenshot.");
    const did = (tool: ToolDef | undefined, inputMatch?: RegExp): number =>
      ep.actions.filter(
        (a) => tool !== undefined && a.name === tool.name && (!inputMatch || inputMatch.test(JSON.stringify(a.input))),
      ).length;

    // A real agent could loop forever on a page it misreads; a scripted one must not.
    if (ep.actions.length > 30) {
      return finishCall(req, false, "Action budget exceeded without reaching a verdict; see prior observations.");
    }

    // Clicks can trigger JS navigations (location.href) that race a read_page
    // fired straight after: the snapshot may show the pre-navigation page, or
    // the read may fail mid-transition. Before judging "the page did not
    // change" a competent agent waits for the load to settle and looks again.
    // Wait and re-read share one turn (the loop executes both calls) to fit
    // the level layer's tight per-step turn budget; at most two settles per
    // click, so a genuinely dead button still fails deterministically.
    const lastClickIdx = ep.actions.reduce(
      (idx, a, i) => (clickTool !== undefined && a.name === clickTool.name ? i : idx),
      -1,
    );
    const waitedSinceLastClick = ep.actions
      .slice(lastClickIdx + 1)
      .filter((a) => waitTool !== undefined && a.name === waitTool.name).length;
    const waitAndReread = (): ModelResponse => ({
      content: [
        { type: "text", text: "Waiting for the page to settle, then re-reading it." },
        { type: "tool_use", id: `mock_${++nextId}`, name: waitTool!.name, input: {} },
        { type: "tool_use", id: `mock_${++nextId}`, name: readTool.name, input: {} },
      ],
      stopReason: "tool_use",
    });
    const settleAfterClick = (): ModelResponse | null =>
      waitTool !== undefined && lastClickIdx !== -1 && waitedSinceLastClick < 2
        ? waitAndReread()
        : null;
    // Verification steps have no click of their own, but the page they landed
    // on may still be mid-parse (inline scripts populating the DOM). One
    // settle per episode before any negative judgment keeps observation-only
    // steps deterministic too.
    const waitsInEpisode = ep.actions.filter(
      (a) => waitTool !== undefined && a.name === waitTool.name,
    ).length;
    const settleBeforeJudging = (): ModelResponse | null =>
      waitTool !== undefined && waitsInEpisode === 0 ? waitAndReread() : null;

    // Observe before deciding, and re-observe after every action that can
    // change the page. Typing into a field cannot navigate, so it skips the
    // re-read — that keeps every level User step inside its turn budget.
    const mutated =
      last !== undefined &&
      last.name !== readTool.name &&
      last.name !== shotTool?.name &&
      last.name !== typeTool?.name &&
      !/finish|verdict|report/i.test(last.name);
    if (snap === "" || mutated) return toolCall(readTool.name, {}, "Reading the page.");

    // Page-state classification — all verdicts flow from these observations.
    const onCatalog = /lantern classic/i.test(snap) && /lantern pro/i.test(snap) && /\$\s*49/.test(snap);
    const onOrderForm = /place order/i.test(snap) && /quantity/i.test(snap);
    const onNewsletter = /newsletter/i.test(snap) && /no thanks/i.test(snap);
    const onConfirm = /order confirmed/i.test(snap);
    const blank = /about:blank/i.test(snap) || excerpt(snap).length < 40;

    const task = ep.task;

    // ---- Step 8: the integrity-veto step. Level asks whether the
    // never-condition (a charge the user did not choose) "was NOT observed
    // during this run" — so the auditor reads the current page, then checks
    // everything the run actually saw. Evidence present → honest failure
    // (level flags the veto step); the report-level "veto" verdict itself
    // still belongs to the True layer alone.
    if (/integrity veto|never adds a charge/i.test(task)) {
      const observed = `${runEvidence}\n${requestText(req)}`;
      const recurring = RECURRING_RE.exec(observed);
      return finishCall(
        req,
        recurring === null,
        recurring
          ? `Observed the never-condition occur during this run: the confirmation page showed "${quoteAround(observed, recurring.index)}" — a recurring charge the user never explicitly chose.`
          : "No charge appeared anywhere in the flow beyond the order total the user explicitly chose.",
      );
    }

    // ---- Plumb goal: drive the entire flow, judge the confirmation at the end.
    if (/can order|goal/i.test(task)) {
      if (blank && navTool && did(navTool) === 0) {
        const url = baseUrl(req);
        if (url) return toolCall(navTool.name, { [pickKey(navTool, ["url", "href", "target"], "url")]: url }, "Opening the site.");
      }
      if (onCatalog && clickTool && did(clickTool, /lantern classic/i) === 0) {
        return clickTarget("the 'Order the Lantern Classic' link");
      }
      if (onOrderForm) {
        if (typeTool && did(typeTool, /your name/i) === 0) return typeInto("the 'Your name' field", shopper);
        if (typeTool && did(typeTool, /quantity/i) === 0) return typeInto("the 'Quantity' field", "2");
        if (clickTool && did(clickTool, /place order/i) === 0) return clickTarget("the 'Place Order' button");
        return settleAfterClick() ?? finishCall(req, false, "Filled the form and clicked 'Place Order', but the page never left the order form — the purchase path cannot complete.");
      }
      if (onNewsletter && clickTool && did(clickTool, /no thanks/i) === 0) {
        return clickTarget("the 'No thanks, continue to my order' link");
      }
      if (onConfirm) {
        if (shotTool && did(shotTool) === 0) return takeShot("confirmation");
        const ok = /lantern classic/i.test(snap) && /58\.00/.test(snap);
        if (!ok) {
          const settled = settleAfterClick();
          if (settled) return settled;
        }
        return finishCall(
          req,
          ok,
          ok
            ? `Ordered 2 × Lantern Classic and reached a confirmation showing the right item and $58.00 total. Page text: ${excerpt(snap)}`
            : `Reached a confirmation but it does not honestly summarize the order (expected 2 × Lantern Classic, $58.00). Page text: ${excerpt(snap)}`,
        );
      }
      return settleAfterClick() ?? finishCall(req, false, `Stuck: the page matches no known state of the order flow. Observed: ${excerpt(snap)}`);
    }

    // ---- Level User steps (perform, then report whether it worked).
    if (/opens? the catalog/i.test(task)) {
      if (onCatalog) return finishCall(req, true, "Catalog page is open and showing the product list.");
      if (navTool && did(navTool) === 0) {
        const url = baseUrl(req);
        if (url) return toolCall(navTool.name, { [pickKey(navTool, ["url", "href", "target"], "url")]: url }, "Opening the catalog.");
      }
      return finishCall(req, false, `Could not reach the catalog. Observed: ${excerpt(snap)}`);
    }

    if (/order page/i.test(task) && /opens?/i.test(task)) {
      if (onOrderForm) return finishCall(req, true, "Order page for the Lantern Classic is open.");
      if (onCatalog && clickTool && did(clickTool) === 0) return clickTarget("the 'Order the Lantern Classic' link");
      return settleAfterClick() ?? finishCall(req, false, `Could not open the order page. Observed: ${excerpt(snap)}`);
    }

    if (/fills? in|submits?/i.test(task)) {
      if (onOrderForm) {
        if (typeTool && did(typeTool, /your name/i) === 0) return typeInto("the 'Your name' field", shopper);
        if (typeTool && did(typeTool, /quantity/i) === 0) return typeInto("the 'Quantity' field", "2");
        if (clickTool && did(clickTool, /place order/i) === 0) return clickTarget("the 'Place Order' button");
        // Submit was clicked, the page settled, and the re-read still shows
        // the form: dead button.
        return settleAfterClick() ?? finishCall(req, false, "Filled in name and quantity and clicked 'Place Order', but the page did not change — the order was never submitted.");
      }
      if (onConfirm || onNewsletter) return finishCall(req, true, "Order submitted; the site moved on from the order form.");
      return settleAfterClick() ?? finishCall(req, false, `Expected to submit the order form. Observed: ${excerpt(snap)}`);
    }

    if (/clicks? done/i.test(task)) {
      if (onNewsletter && clickTool && did(clickTool, /no thanks/i) === 0) {
        return clickTarget("the 'No thanks, continue to my order' link");
      }
      if (onConfirm) {
        if (shotTool && did(shotTool) === 0) return takeShot("confirmation");
        if (clickTool && did(clickTool, /done/i) === 0) return clickTarget("the 'Done' link");
      }
      if (onCatalog) return finishCall(req, true, "Clicked Done and returned to the catalog.");
      return settleAfterClick() ?? finishCall(req, false, `Could not finish via Done. Observed: ${excerpt(snap)}`);
    }

    // ---- Level System steps (observe, then judge the page against the script).
    if (/two products/i.test(task)) {
      const priceCount = (snap.match(/\$\s*\d+(?:\.\d{2})?/g) ?? []).length;
      const ok = /lantern classic/i.test(snap) && /lantern pro/i.test(snap) && priceCount >= 2;
      if (!ok) {
        const settled = settleBeforeJudging();
        if (settled) return settled;
      }
      return finishCall(
        req,
        ok,
        ok
          ? "Catalog lists Lantern Classic and Lantern Pro, each with a price."
          : `Expected two priced products. Observed: ${excerpt(snap)}`,
      );
    }

    if (/order form/i.test(task)) {
      const ok = onOrderForm && /name/i.test(snap);
      if (!ok) {
        const settled = settleBeforeJudging();
        if (settled) return settled;
      }
      return finishCall(
        req,
        ok,
        ok
          ? "Order form shows name and quantity fields and a Place Order button."
          : `Expected the order form. Observed: ${excerpt(snap)}`,
      );
    }

    if (/confirmation/i.test(task)) {
      if (onConfirm && shotTool && did(shotTool) === 0) return takeShot("confirmation");
      const ok = onConfirm && /lantern classic/i.test(snap) && /\$\s*\d+\.\d{2}/.test(snap);
      if (!ok) {
        const settled = settleBeforeJudging();
        if (settled) return settled;
      }
      return finishCall(
        req,
        ok,
        ok
          ? `Confirmation summarizes the order. Page text: ${excerpt(snap)}`
          : `Expected an order confirmation immediately after submission. Observed instead: ${excerpt(snap)}`,
      );
    }

    // Unrecognized task: report what is visible and let the layer judge.
    return finishCall(req, !blank, `Observed page: ${excerpt(snap)}`);
  };
}
