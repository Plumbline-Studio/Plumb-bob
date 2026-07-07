// Shared types for the Plumb Bob run report.
// These mirror /schema/run.schema.json — that schema is the contract; these
// types are the in-engine convenience view. report.ts validates the assembled
// object against the JSON Schema before it is written, so a drift between the
// two is caught at runtime, not shipped.

export type Result = "pass" | "fail" | "veto";
export type Actor = "User" | "System" | "Bob";

export interface Trigger {
  repo: string;
  pr: number | null;
  sha: string;
  preview_url: string;
}

export interface PlumbGoal {
  goal: string;
  status: "pass" | "fail";
  reasoning?: string;
  screenshots?: string[];
}

export interface PlumbLayer {
  status: "pass" | "fail" | "skipped";
  goals: PlumbGoal[];
}

export interface LevelStep {
  n: number;
  actor: Actor;
  action: string;
  status: "pass" | "fail" | "divergence";
  note?: string;
  screenshot?: string;
}

export interface Divergence {
  step: number;
  // Always framed as the Matthies question: script wrong, or build wrong?
  question: string;
}

export interface LevelLayer {
  status: "pass" | "fail" | "divergence" | "skipped";
  playscript: string;
  steps: LevelStep[];
  divergences?: Divergence[];
}

export interface TrueScore {
  heuristic: string;
  score: number; // -2..+3
  citation: string;
  rationale?: string;
}

export interface TrueVeto {
  veto: string;
  evidence: string;
}

export interface TrueLayer {
  status: "pass" | "veto" | "skipped";
  scores: TrueScore[];
  vetoes?: TrueVeto[];
}

export interface RunReport {
  schema_version: "1.0";
  run_id: string;
  project: string;
  trigger: Trigger;
  started_at: string;
  finished_at: string;
  result: Result;
  layers: {
    plumb: PlumbLayer;
    level: LevelLayer;
    true: TrueLayer;
  };
}

// The parsed form of a Playscript, produced by level.ts. The parser is the
// authoritative source of step numbers, actors, and action text — the agent
// only fills in per-step status/notes at execution time.
export interface ParsedStep {
  n: number;
  actor: Actor;
  action: string;
  // A step may declare an inline hard-fail condition, e.g. "(Hard-block here = FAIL)".
  declaresFail: boolean;
}

export interface ParsedPlayscript {
  flow: string;
  purpose: string;
  steps: ParsedStep[];
}
