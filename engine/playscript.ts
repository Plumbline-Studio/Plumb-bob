/**
 * Playscript parser (schema/playscript.spec.md).
 *
 * parsePlayscript turns Matthies-format text into a ParsedPlayscript;
 * loadPlayscripts reads a directory of them. Malformed input throws with
 * file:line context — a playscript the engine cannot trust is a run that
 * must not start.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedPlayscript, ParsedStep } from "./types.js";

const HEADER_RE = /^PLAYSCRIPT:\s*(.+?)\s*$/;
// Step lines carry light left-padding for number alignment (" 1." vs "10.");
// continuation lines are indented well past 4 columns, so they never match.
const STEP_RE = /^\s{0,4}(\d+)\.\s+(\S.*)$/;
// Actor = capitalized token(s) separated from the action by 2+ spaces — the
// double space is the column separator Matthies format relies on.
const ACTOR_RE = /^([A-Z][\w'&.-]*(?: [A-Z][\w'&.-]*)*)\s{2,}(\S.*)$/;

const CANONICAL_ACTORS = new Set(["User", "System", "Bob"]);
const BOLD_NEVER_RE = /\*\*[^*]*never/i;

/**
 * Parse one playscript. `file` is used only for error/warning context and is
 * echoed back on the result. Throws Error("<file>:<line>: ...") on any
 * structural problem: missing header, missing Purpose, gap in step numbering,
 * or a step without the double-space actor/action separator.
 */
export function parsePlayscript(text: string, file: string): ParsedPlayscript {
  const lines = text.split(/\r?\n/);
  const fail = (line: number, msg: string): never => {
    throw new Error(`${file}:${line}: ${msg}`);
  };

  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const headerMatch = lines[i]?.match(HEADER_RE);
  if (!headerMatch) {
    fail(i + 1, `expected "PLAYSCRIPT: <name>" header, got ${JSON.stringify(lines[i] ?? "<end of file>")}`);
  }
  const name = headerMatch![1]!;
  i++;

  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (!lines[i]?.startsWith("Purpose:")) {
    fail(i + 1, `expected "Purpose: <paragraph>" after header, got ${JSON.stringify(lines[i] ?? "<end of file>")}`);
  }
  const purposeParts = [lines[i]!.slice("Purpose:".length).trim()];
  i++;
  // Purpose paragraph runs to the first blank line (or, defensively, the
  // first step line if the author omitted the blank).
  while (i < lines.length && lines[i]!.trim() !== "" && !STEP_RE.test(lines[i]!)) {
    purposeParts.push(lines[i]!.trim());
    i++;
  }
  const purpose = purposeParts.filter(Boolean).join(" ");

  interface RawStep {
    n: number;
    body: string;
    line: number;
  }
  const raw: RawStep[] = [];
  const warnings: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const stepMatch = line.match(STEP_RE);
    if (stepMatch) {
      const n = Number(stepMatch[1]);
      // Renumbering is schema-visible (divergences cite step numbers), so a
      // gap or restart is a hard error, not something to paper over.
      if (n !== raw.length + 1) {
        fail(i + 1, `step numbering must be continuous: expected ${raw.length + 1}, got ${n}`);
      }
      raw.push({ n, body: stepMatch[2]!, line: i + 1 });
      continue;
    }
    if (raw.length > 0 && /^\s/.test(line)) {
      // Indented continuation joins the previous step's action, single-spaced.
      raw[raw.length - 1]!.body += ` ${line.trim()}`;
      continue;
    }
    // Non-step annotation (e.g. the "⚠ SCAFFOLD" block): ignored, but
    // surfaced so authors know the engine is not executing it.
    warnings.push(`${file}:${i + 1}: ignored non-step line: ${line.trim()}`);
  }
  if (raw.length === 0) fail(lines.length, "no numbered steps found");

  const steps: ParsedStep[] = raw.map((r) => {
    const actorMatch = r.body.match(ACTOR_RE);
    if (!actorMatch) {
      fail(r.line, `step ${r.n}: expected "<Actor>  <action>" with a two-space separator, got ${JSON.stringify(r.body)}`);
    }
    const rawActor = actorMatch![1]!;
    const action = actorMatch![2]!;
    // Named external parties ("Payment API") are things the agent observes,
    // not drives — report them as System, keep the name in rawActor.
    const actor = CANONICAL_ACTORS.has(rawActor)
      ? (rawActor as ParsedStep["actor"])
      : "System";
    return {
      n: r.n,
      actor,
      rawActor,
      action,
      hardFail: action.includes("= FAIL"),
      isVeto: false,
    };
  });

  // Veto detection needs the finished list: the bold-never form alone only
  // counts in the final step, where playscripts state closing invariants.
  for (const [idx, step] of steps.entries()) {
    const boldNever = BOLD_NEVER_RE.test(step.action);
    step.isVeto =
      (boldNever && /integrity veto/i.test(step.action)) ||
      (boldNever && idx === steps.length - 1);
  }

  return { file, name, purpose, steps, warnings };
}

/**
 * Load every playscript in a directory, sorted by filename. Accepts both
 * `<flow>.md` and `<flow>.playscript.md`; files starting with "_" are drafts
 * and are skipped. Any malformed file aborts the whole load.
 */
export async function loadPlayscripts(dir: string): Promise<ParsedPlayscript[]> {
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort();
  return Promise.all(
    files.map(async (f) => parsePlayscript(await readFile(join(dir, f), "utf8"), f)),
  );
}
