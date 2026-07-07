// Reporting out: one PR comment, and an optional Console ingest POST.
//
// Exactly ONE PR comment per run — we upsert by a hidden marker so re-runs
// update in place instead of piling up. The Console ingest is downstream and
// never a gate: an ingest failure is logged and swallowed, never fails the run.

import type { RunReport } from "./types.js";
import type { Config } from "./config.js";

const MARKER = "<!-- plumb-bob -->";

const RESULT_BADGE: Record<string, string> = {
  pass: "✅ **PASS**",
  fail: "❌ **FAIL**",
  veto: "⛔ **VETO** (integrity block)",
};

function layerBadge(status: string): string {
  return (
    { pass: "✅", fail: "❌", veto: "⛔", divergence: "⚠️", skipped: "⏭️" }[status] ?? "•"
  );
}

export function renderComment(report: RunReport): string {
  const { layers } = report;
  const lines: string[] = [];

  lines.push(MARKER);
  lines.push(`## Plumb Bob — ${RESULT_BADGE[report.result] ?? report.result}`);
  lines.push(`*The weight that tests true.* · \`${report.project}\` · run \`${report.run_id}\``);
  lines.push("");

  // Plumb
  lines.push(`### ${layerBadge(layers.plumb.status)} Plumb — functional (${layers.plumb.status})`);
  if (layers.plumb.goals.length === 0) {
    lines.push("_No goals run._");
  } else {
    for (const g of layers.plumb.goals) {
      lines.push(`- ${layerBadge(g.status)} **${g.goal}**`);
      if (g.reasoning) lines.push(`  - ${g.reasoning}`);
      if (g.screenshots?.length) lines.push(`  - _${g.screenshots.length} screenshot(s) in run artifacts_`);
    }
  }
  lines.push("");

  // Level
  lines.push(`### ${layerBadge(layers.level.status)} Level — procedural (${layers.level.status})`);
  lines.push(`Playscript: **${layers.level.playscript}**`);
  if (layers.level.steps.length) {
    const fails = layers.level.steps.filter((s) => s.status === "fail");
    const divs = layers.level.steps.filter((s) => s.status === "divergence");
    lines.push(
      `${layers.level.steps.length} steps · ` +
        `${layers.level.steps.filter((s) => s.status === "pass").length} pass · ` +
        `${fails.length} fail · ${divs.length} divergence`,
    );
    for (const s of fails) lines.push(`- ❌ Step ${s.n} (${s.actor}): ${s.action}${s.note ? ` — ${s.note}` : ""}`);
  }
  if (layers.level.divergences?.length) {
    lines.push("");
    lines.push("**Divergences — _script wrong, or build wrong?_ (you decide):**");
    for (const d of layers.level.divergences) lines.push(`- ⚠️ Step ${d.step}: ${d.question}`);
  }
  lines.push("");

  // True
  lines.push(`### ${layerBadge(layers.true.status)} True — principled (${layers.true.status})`);
  if (layers.true.scores.length) {
    for (const s of layers.true.scores) {
      const sign = s.score > 0 ? `+${s.score}` : `${s.score}`;
      lines.push(`- \`${sign}\` **${s.heuristic}** [${s.citation}]${s.rationale ? ` — ${s.rationale}` : ""}`);
    }
  } else {
    lines.push("_No heuristics scored._");
  }
  if (layers.true.vetoes?.length) {
    lines.push("");
    lines.push("**⛔ Integrity vetoes (merge-blocking):**");
    for (const v of layers.true.vetoes) lines.push(`- **${v.veto}** — ${v.evidence}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("*Plumbline Studio · Build it true.*");

  return lines.join("\n");
}

async function gh(config: Config, path: string, init: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function postComment(
  config: Config,
  body: string,
  log: (msg: string) => void,
): Promise<void> {
  if (!config.githubToken || !config.pr || !config.repo.includes("/")) {
    log("PR comment skipped (no token / PR number / repo).");
    return;
  }
  try {
    const list = await gh(config, `/repos/${config.repo}/issues/${config.pr}/comments?per_page=100`, {
      method: "GET",
    });
    const comments = (await list.json()) as { id: number; body: string }[];
    const existing = Array.isArray(comments) ? comments.find((c) => c.body?.includes(MARKER)) : undefined;

    const res = existing
      ? await gh(config, `/repos/${config.repo}/issues/comments/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        })
      : await gh(config, `/repos/${config.repo}/issues/${config.pr}/comments`, {
          method: "POST",
          body: JSON.stringify({ body }),
        });

    if (!res.ok) log(`PR comment failed: ${res.status} ${await res.text()}`);
    else log(`PR comment ${existing ? "updated" : "posted"}.`);
  } catch (err) {
    log(`PR comment error (non-fatal): ${String(err)}`);
  }
}

// Console ingest — downstream, never a gate. Any failure is swallowed.
export async function ingest(
  config: Config,
  report: RunReport,
  log: (msg: string) => void,
): Promise<void> {
  if (!config.ingestUrl) return;
  try {
    const res = await fetch(config.ingestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.ingestKey ? { Authorization: `Bearer ${config.ingestKey}` } : {}),
      },
      body: JSON.stringify(report),
    });
    if (!res.ok) log(`Console ingest non-OK (${res.status}); ignored — viewer is never a gate.`);
    else log("Console ingest ok.");
  } catch (err) {
    log(`Console ingest error (ignored): ${String(err)}`);
  }
}
