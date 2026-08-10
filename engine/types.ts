/**
 * Plumb Bob shared contracts.
 *
 * This module is the single source of truth for every type the three layer
 * agents (plumb, level, true), the model adapter, the browser adapter, and
 * the eval harness code against. It intentionally contains no runtime code:
 * importing it can never pull in Playwright, the Anthropic SDK, or Node
 * built-ins.
 *
 * The report types mirror schema/run.schema.json exactly — the JSON schema
 * is the wire contract, these types are its compile-time shadow. If they
 * disagree, the schema wins and this file is wrong.
 */

// ---------------------------------------------------------------------------
// Run report (mirrors schema/run.schema.json, schema_version "1.0")
// ---------------------------------------------------------------------------

export type LayerName = "plumb" | "level" | "true";

/** Where the run came from. repo/sha fall back to "local"/"dev" outside CI. */
export interface TriggerInfo {
  repo: string;
  /** Pull request number; null for non-PR runs (pushes, local dev). */
  pr: number | null;
  sha: string;
  preview_url: string;
}

/** One Plumb-layer goal verdict. Screenshots are artifact-relative paths. */
export interface GoalResult {
  goal: string;
  status: "pass" | "fail";
  reasoning?: string;
  screenshots?: string[];
}

/** Plumb layer: agentic functional verification against stated goals. */
export interface PlumbLayer {
  status: "pass" | "fail" | "skipped";
  goals: GoalResult[];
}

/**
 * One executed playscript step.
 * "skipped" covers Bob steps whose integration isn't configured (per the
 * playscript spec's execution semantics); "divergence" means observed
 * behavior differs from the script without a declared `= FAIL`.
 */
export interface StepResult {
  n: number;
  actor: "User" | "System" | "Bob";
  action: string;
  status: "pass" | "fail" | "divergence" | "skipped";
  /** Free text; carries the named external party for mapped System actors. */
  note?: string;
  /** Artifact-relative screenshot path. */
  screenshot?: string;
}

/** The Matthies question surfaced for a human: script wrong, or build wrong? */
export interface DivergenceRecord {
  step: number;
  question: string;
}

/** Level layer: playscript execution. Divergence alone never fails a run. */
export interface LevelLayer {
  status: "pass" | "fail" | "divergence" | "skipped";
  playscript: string;
  steps: StepResult[];
  divergences?: DivergenceRecord[];
}

/** One principles heuristic score, always citing the principle that drove it. */
export interface Score {
  heuristic: string;
  /** Bounded per schema: -2..3. */
  score: number;
  citation: string;
  rationale?: string;
}

/** A tripped integrity veto with the evidence that tripped it. */
export interface Veto {
  veto: string;
  evidence: string;
}

/** True layer: principles scoring. A veto outranks everything else. */
export interface TrueLayer {
  status: "pass" | "veto" | "skipped";
  scores: Score[];
  vetoes?: Veto[];
}

/**
 * The complete run report — the API downstream consumers (Console, notifiers)
 * parse. Never hand them prose; hand them this.
 */
export interface RunReport {
  schema_version: "1.0";
  run_id: string;
  project: string;
  trigger: TriggerInfo;
  started_at: string;
  finished_at: string;
  result: "pass" | "fail" | "veto";
  layers: {
    plumb: PlumbLayer;
    level: LevelLayer;
    true: TrueLayer;
  };
}

// ---------------------------------------------------------------------------
// Consumer configuration (mirrors plumb-bob/plumb-bob.config.json)
// ---------------------------------------------------------------------------

/** Per-playscript settings declared by the consumer repo. */
export interface PlayscriptConfig {
  /** Route the flow starts at, relative to the preview URL. */
  route: string;
  /**
   * Plumb-layer goals for this flow. When absent the engine synthesizes one
   * goal from the playscript's Purpose paragraph.
   */
  goals?: string[];
}

/** Agent tuning knobs. loadConfig fills every field with defaults. */
export interface AgentConfig {
  layers: LayerName[];
  max_steps: number;
  screenshot_every_step: boolean;
}

/**
 * Bob-step integrations. A missing entry means the corresponding Bob steps
 * are skipped (never failed). Shapes are open — each integration owner
 * defines its own keys.
 */
export interface IntegrationsConfig {
  supabase?: { persistence_checks?: boolean; [key: string]: unknown };
  posthog?: { project_ref?: string; [key: string]: unknown };
  revenuecat?: { sandbox?: boolean; [key: string]: unknown };
  [key: string]: Record<string, unknown> | undefined;
}

/**
 * The consumer contract, post-load: loadConfig validates required fields and
 * applies defaults, so `agent` and `playscripts` are always present here.
 */
export interface PlumbBobConfig {
  /** Consumer-declared slug, e.g. "owt". */
  project: string;
  playscripts: Record<string, PlayscriptConfig>;
  integrations?: IntegrationsConfig;
  agent: AgentConfig;
}

// ---------------------------------------------------------------------------
// Parsed playscript
// ---------------------------------------------------------------------------

/**
 * One parsed playscript step. Named external parties ("Payment API") map to
 * actor "System" for the report enum; rawActor preserves the original name so
 * the level layer can carry it into StepResult.note.
 */
export interface ParsedStep {
  n: number;
  actor: "User" | "System" | "Bob";
  rawActor: string;
  action: string;
  /** Step declared `= FAIL` inline: divergence here fails the run. */
  hardFail: boolean;
  /** Step declares an integrity veto condition for the True layer. */
  isVeto: boolean;
}

/** A playscript parsed from `plumb-bob/playscripts/<flow>[.playscript].md`. */
export interface ParsedPlayscript {
  /** Filename (or path) the script was parsed from, as given to the parser. */
  file: string;
  name: string;
  purpose: string;
  steps: ParsedStep[];
  /** Non-step annotation lines the parser ignored (e.g. scaffold notes). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Model client (implemented by engine/model/anthropic.ts and harness mocks)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

/** Base64 PNG only — that is all the browser adapter produces. */
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: "image/png"; data: string };
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface ModelMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** Anthropic-shaped tool definition; input_schema is JSON Schema. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools?: ToolDef[];
  maxTokens: number;
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

/**
 * Minimal model seam. Layers only ever call complete(); everything about
 * retries, streaming, and model choice hides behind the implementation.
 * The eval harness substitutes a scripted mock through this same interface.
 */
export interface ModelClient {
  complete(req: ModelRequest): Promise<ModelResponse>;
}

// ---------------------------------------------------------------------------
// Browser tools (implemented over Playwright by the plumb/level layers' owner)
// ---------------------------------------------------------------------------

/** An interactable element, described for the model, not for Playwright. */
export interface PageElement {
  role: string;
  name: string;
  /** Hint the adapter can resolve back to a locator; opaque to the model. */
  selectorHint: string;
}

/** What the agent can "see": enough to decide the next action. */
export interface PageSnapshot {
  url: string;
  title: string;
  visibleText: string;
  elements: PageElement[];
}

/**
 * The browser seam layers drive. Targets are human descriptions ("the
 * Continue button") or selectorHints from a prior readPage() — resolution is
 * the adapter's problem. screenshot() returns an artifact-relative path so
 * reports stay portable across artifact stores.
 */
export interface BrowserTools {
  navigate(url: string): Promise<void>;
  /** Fresh browser context: no cookies, no storage — a brand-new visitor. */
  freshContext(): Promise<void>;
  click(target: string): Promise<void>;
  type(target: string, text: string): Promise<void>;
  press(key: string): Promise<void>;
  select(target: string, value: string): Promise<void>;
  waitForLoad(): Promise<void>;
  screenshot(name: string): Promise<string>;
  readPage(): Promise<PageSnapshot>;
}

// ---------------------------------------------------------------------------
// Engine context and layer runner
// ---------------------------------------------------------------------------

/**
 * One step's worth of run evidence: what the level layer did and what the
 * page showed right after. Accumulated on EngineContext.evidence so later
 * consumers in the same run (the integrity-veto step, the True layer) can
 * judge from what the run actually observed, not just the final page.
 */
export interface StepEvidence {
  n: number;
  actor: StepResult["actor"];
  action: string;
  status: StepResult["status"];
  /** The step's result note (reasoning, external-party tag, etc.). */
  note?: string;
  /** Bounded excerpt (~600 chars) of the page's visible text after the step. */
  textExcerpt?: string;
}

/**
 * Everything a layer runner receives. The orchestrator constructs one per
 * run; layers must not reach around it to process.env.
 */
export interface EngineContext {
  previewUrl: string;
  config: PlumbBobConfig;
  /** Directory containing plumb-bob.config.json (integration paths resolve here). */
  configDir: string;
  playscriptsDir: string;
  /** Absolute path; screenshot()/report paths are relative to this. */
  artifactsDir: string;
  model: ModelClient;
  log: (msg: string) => void;
  /**
   * Per-step evidence accumulated during this run. The level layer creates
   * and appends to it as steps execute; the True layer reads it to ground
   * its prompt in observed page text. Optional: absent until level runs
   * (or when level is skipped), and consumers must degrade honestly then.
   */
  evidence?: StepEvidence[];
}

/**
 * A layer module (engine/plumb.ts, engine/level.ts, engine/true.ts)
 * default-exports one of these. It returns its layer's report fragment;
 * the orchestrator never inspects how it got there.
 */
export type LayerRunner = (
  ctx: EngineContext,
  playscript: ParsedPlayscript,
) => Promise<PlumbLayer | LevelLayer | TrueLayer>;
