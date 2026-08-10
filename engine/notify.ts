/**
 * Run report notification: one markdown PR comment plus an optional ingest
 * POST for the downstream viewer.
 *
 * renderComment is pure: RunReport in, markdown out. postComment finds and
 * updates its own previous comment (the COMMENT_MARKER) or creates one via
 * the GitHub REST API. postIngest ships the report to the Console ingest
 * endpoint. Neither network call ever throws — the comment and the viewer
 * are downstream of the verdict, never a gate on it.
 */

import { readdir } from "node:fs/promises";
import type { RunReport } from "./types.js";

/** Hidden marker that lets postComment find and update its own comment. */
export const COMMENT_MARKER = "<!-- plumb-bob-run -->";

const ACTION_TRUNCATE = 60;

/** Render the single PR comment for a run. Tables, not prose. */
export function renderComment(report: RunReport): string {
  const { plumb, level, true: trueLayer } = report.layers;
  const verdict = report.result === "pass" ? "pass" : report.result.toUpperCase();
  const sha = report.trigger.sha.slice(0, 7);
  const lines: string[] = [
    COMMENT_MARKER,
    `**PLUMB BOB — ${verdict}** · ${report.project} · ${sha}`,
    "",
    `### Plumb — ${plumb.status}`,
  ];

  if (plumb.goals.length === 0) {
    lines.push("", plumb.status === "skipped" ? "_skipped_" : "_no goals evaluated_");
  } else {
    lines.push("", "| Goal | Status | Reasoning |", "| --- | --- | --- |");
    for (const g of plumb.goals) {
      lines.push(`| ${cell(g.goal)} | ${g.status} | ${cell(g.reasoning ?? "")} |`);
    }
  }

  lines.push("", `### Level — ${level.status} (${level.playscript})`);
  if (level.steps.length === 0) {
    lines.push("", level.status === "skipped" ? "_skipped_" : "_no steps executed_");
  } else {
    lines.push("", "| # | Actor | Action | Status |", "| --- | --- | --- | --- |");
    for (const s of level.steps) {
      lines.push(`| ${s.n} | ${s.actor} | ${cell(truncate(s.action))} | ${s.status} |`);
    }
  }
  if (level.divergences && level.divergences.length > 0) {
    lines.push("", "**Divergences — human decides:**");
    for (const d of level.divergences) {
      lines.push(`> **Step ${d.step}:** ${d.question}`);
    }
  }

  lines.push("", `### True — ${trueLayer.status}`);
  if (trueLayer.scores.length === 0) {
    lines.push("", trueLayer.status === "skipped" ? "_skipped_" : "_no heuristics scored_");
  } else {
    lines.push("", "| Heuristic | Score | Citation | Rationale |", "| --- | --- | --- | --- |");
    for (const s of trueLayer.scores) {
      lines.push(`| ${cell(s.heuristic)} | ${s.score} | ${cell(s.citation)} | ${cell(s.rationale ?? "")} |`);
    }
  }
  if (trueLayer.vetoes && trueLayer.vetoes.length > 0) {
    lines.push("", "**INTEGRITY VETO — blocks merge regardless of totals:**");
    for (const v of trueLayer.vetoes) {
      lines.push(`> **${v.veto}** — ${v.evidence}`);
    }
  }

  lines.push("", "---", `The weight that tests true. · run ${report.run_id} · Build it true.`);
  return lines.join("\n");
}

/**
 * Options for postComment. Everything defaults from the standard GitHub
 * Actions environment; tests inject fetchImpl and log.
 */
export interface PostCommentOptions {
  token?: string | undefined;
  /** "owner/repo", e.g. GITHUB_REPOSITORY. */
  repo?: string | undefined;
  prNumber?: number | undefined;
  apiBase?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  log?: ((msg: string) => void) | undefined;
}

/**
 * Post the run comment to the PR, updating this bot's previous comment when
 * one exists (found by COMMENT_MARKER). Missing PR context or any API failure
 * logs and returns — the comment never gates the run.
 */
export async function postComment(report: RunReport, opts: PostCommentOptions = {}): Promise<void> {
  const log = opts.log ?? ((msg: string) => console.log(`[plumb-bob] ${msg}`));
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  const repo = opts.repo ?? process.env.GITHUB_REPOSITORY;
  const pr = opts.prNumber ?? report.trigger.pr ?? prNumberFromEnv();
  if (!token || !repo || pr === null) {
    log("no PR context (need GITHUB_TOKEN, GITHUB_REPOSITORY, and a PR number) — skipping comment");
    return;
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const api = opts.apiBase ?? process.env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "plumb-bob",
  };

  try {
    let existingId: number | null = null;
    const listRes = await fetchFn(`${api}/repos/${repo}/issues/${pr}/comments?per_page=100`, {
      headers,
    });
    if (listRes.ok) {
      const comments = (await listRes.json()) as Array<{ id: number; body?: string }>;
      existingId = comments.find((c) => c.body?.includes(COMMENT_MARKER))?.id ?? null;
    } else {
      log(`could not list PR comments (${listRes.status}); posting a new one`);
    }

    const body = JSON.stringify({ body: renderComment(report) });
    const res = existingId
      ? await fetchFn(`${api}/repos/${repo}/issues/comments/${existingId}`, {
          method: "PATCH",
          headers,
          body,
        })
      : await fetchFn(`${api}/repos/${repo}/issues/${pr}/comments`, {
          method: "POST",
          headers,
          body,
        });
    if (!res.ok) {
      log(`comment ${existingId ? "update" : "post"} failed: HTTP ${res.status}`);
      return;
    }
    log(`comment ${existingId ? "updated" : "posted"} on ${repo}#${pr}`);
  } catch (err) {
    log(`comment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface PostIngestOptions {
  ingestUrl: string;
  ingestKey?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  log?: ((msg: string) => void) | undefined;
}

/**
 * POST the report (plus a listing of artifact files) to the viewer's ingest
 * endpoint. ANY failure logs and returns — the viewer is downstream, never a
 * gate.
 */
export async function postIngest(
  report: RunReport,
  artifactsDir: string,
  opts: PostIngestOptions,
): Promise<void> {
  const log = opts.log ?? ((msg: string) => console.log(`[plumb-bob] ${msg}`));
  if (!opts.ingestUrl) {
    log("no ingest URL configured — skipping ingest");
    return;
  }
  let artifacts: string[] = [];
  try {
    artifacts = ((await readdir(artifactsDir, { recursive: true })) as string[])
      .filter((f) => f.endsWith(".png") || f.endsWith(".json"))
      .sort();
  } catch {
    // An unlistable artifacts dir just means an empty listing.
  }
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.ingestKey) headers.authorization = `Bearer ${opts.ingestKey}`;
    const fetchFn = opts.fetchImpl ?? fetch;
    const res = await fetchFn(opts.ingestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ report, artifacts }),
    });
    if (!res.ok) {
      log(`ingest failed: HTTP ${res.status} from ${opts.ingestUrl}`);
      return;
    }
    log(`ingested run ${report.run_id}`);
  } catch (err) {
    log(`ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Table cells must not break on user text: escape pipes, flatten newlines. */
function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

function truncate(text: string): string {
  return text.length <= ACTION_TRUNCATE ? text : `${text.slice(0, ACTION_TRUNCATE - 1)}…`;
}

function prNumberFromEnv(): number | null {
  const explicit = process.env.PR_NUMBER ?? process.env.GITHUB_PR_NUMBER;
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
  const refMatch = process.env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//);
  return refMatch ? Number(refMatch[1]) : null;
}
