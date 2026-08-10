import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMENT_MARKER, postComment, postIngest, renderComment } from "../engine/notify.js";
import type { RunReport } from "../engine/types.js";

const MATTHIES_QUESTION =
  "Script says 4 screens, build shows 3 — script wrong or build wrong?";
const VETO_EVIDENCE = "seeded testimonials render on the production path (diff lines 40-62)";

/** A pass verdict that still carries a divergence — the Matthies case. */
const passWithDivergence: RunReport = {
  schema_version: "1.0",
  run_id: "11111111-2222-4333-8444-555555555555",
  project: "owt",
  trigger: { repo: "plumbline/owt", pr: 42, sha: "abc1234def5678", preview_url: "https://preview.example.com" },
  started_at: "2026-08-10T12:00:00.000Z",
  finished_at: "2026-08-10T12:05:00.000Z",
  result: "pass",
  layers: {
    plumb: {
      status: "pass",
      goals: [{ goal: "new visitor completes onboarding", status: "pass", reasoning: "reached feed" }],
    },
    level: {
      status: "divergence",
      playscript: "onboarding.md",
      steps: [
        { n: 1, actor: "User", action: "Opens preview URL as a fresh session (no cookies).", status: "pass" },
        { n: 4, actor: "System", action: "Each screen renders without layout shift or dead CTAs.", status: "divergence" },
      ],
      divergences: [{ step: 4, question: MATTHIES_QUESTION }],
    },
    true: {
      status: "pass",
      scores: [{ heuristic: "Reach", score: 2, citation: "H3", rationale: "user drives every screen" }],
    },
  },
};

const vetoReport: RunReport = {
  schema_version: "1.0",
  run_id: "99999999-8888-4777-8666-555555555555",
  project: "owt",
  trigger: { repo: "plumbline/owt", pr: 43, sha: "fedcba9876", preview_url: "https://preview.example.com" },
  started_at: "2026-08-10T13:00:00.000Z",
  finished_at: "2026-08-10T13:04:00.000Z",
  result: "veto",
  layers: {
    plumb: { status: "skipped", goals: [] },
    level: { status: "skipped", playscript: "onboarding.md", steps: [] },
    true: {
      status: "veto",
      scores: [{ heuristic: "Dishonest framing risk", score: -2, citation: "V3" }],
      vetoes: [{ veto: "Dishonest framing (V3)", evidence: VETO_EVIDENCE }],
    },
  },
};

describe("renderComment", () => {
  it("renders the pass-with-divergence report: marker, header, tables, Matthies question, footer", () => {
    const md = renderComment(passWithDivergence);
    expect(md).toContain(COMMENT_MARKER);
    expect(md).toContain("**PLUMB BOB — pass** · owt · abc1234");
    // Plumb goals table.
    expect(md).toContain("| Goal | Status | Reasoning |");
    expect(md).toContain("| new visitor completes onboarding | pass | reached feed |");
    // Level steps table rows carry n/actor/action/status.
    expect(md).toContain("| 1 | User | Opens preview URL as a fresh session (no cookies). | pass |");
    expect(md).toMatch(/\| 4 \| System \| Each screen renders.*\| divergence \|/);
    // The Matthies question appears verbatim, quoted for a human.
    expect(md).toContain(`> **Step 4:** ${MATTHIES_QUESTION}`);
    // True scores table cites the heuristic ID.
    expect(md).toContain("| Reach | 2 | H3 | user drives every screen |");
    expect(md).toContain(
      "The weight that tests true. · run 11111111-2222-4333-8444-555555555555 · Build it true.",
    );
  });

  it("renders the veto report: VETO header, prominent quoted evidence, skipped layers", () => {
    const md = renderComment(vetoReport);
    expect(md).toContain(COMMENT_MARKER);
    expect(md).toContain("**PLUMB BOB — VETO** · owt · fedcba9");
    expect(md).toContain("INTEGRITY VETO");
    expect(md).toContain(`> **Dishonest framing (V3)** — ${VETO_EVIDENCE}`);
    expect(md).toContain("### Plumb — skipped");
    expect(md).toContain("_skipped_");
  });

  it("escapes pipes and truncates long actions so tables never break", () => {
    const report: RunReport = structuredClone(passWithDivergence);
    report.layers.level.steps = [
      {
        n: 1,
        actor: "User",
        action: `Types "a|b" then ${"x".repeat(200)}`,
        status: "pass",
      },
    ];
    const md = renderComment(report);
    expect(md).toContain('Types "a\\|b"');
    expect(md).not.toContain("x".repeat(200));
  });
});

describe("postComment", () => {
  const SAVED_ENV = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_REF", "PR_NUMBER", "GITHUB_PR_NUMBER"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of SAVED_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of SAVED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("logs and skips without throwing when there is no PR context", async () => {
    const logs: string[] = [];
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const report = structuredClone(passWithDivergence);
    report.trigger.pr = null;
    await expect(
      postComment(report, { fetchImpl, log: (m) => logs.push(m) }),
    ).resolves.toBeUndefined();
    expect(logs.join("\n")).toMatch(/no PR context.*skipping comment/);
    expect(calls).toEqual([]);
  });

  it("updates its previous comment when the marker is found", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("/comments?")) {
        return new Response(
          JSON.stringify([
            { id: 3, body: "unrelated" },
            { id: 7, body: `old run\n${COMMENT_MARKER}` },
          ]),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await postComment(passWithDivergence, {
      token: "t",
      repo: "plumbline/owt",
      fetchImpl,
      log: () => {},
    });
    expect(calls.at(-1)).toEqual({
      url: "https://api.github.com/repos/plumbline/owt/issues/comments/7",
      method: "PATCH",
    });
  });

  it("creates a comment when none carries the marker", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    await postComment(passWithDivergence, {
      token: "t",
      repo: "plumbline/owt",
      fetchImpl,
      log: () => {},
    });
    expect(calls.at(-1)).toEqual({
      url: "https://api.github.com/repos/plumbline/owt/issues/42/comments",
      method: "POST",
    });
  });

  it("never throws when the API is unreachable", async () => {
    const logs: string[] = [];
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      postComment(passWithDivergence, {
        token: "t",
        repo: "plumbline/owt",
        fetchImpl,
        log: (m) => logs.push(m),
      }),
    ).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("comment failed: ECONNREFUSED");
  });
});

describe("postIngest", () => {
  it("logs and returns on any failure — the viewer is never a gate", async () => {
    const logs: string[] = [];
    const fetchImpl = (async () => {
      throw new Error("ingest endpoint down");
    }) as unknown as typeof fetch;
    await expect(
      postIngest(passWithDivergence, "/nonexistent-artifacts-dir", {
        ingestUrl: "https://ingest.example.com/runs",
        ingestKey: "k",
        fetchImpl,
        log: (m) => logs.push(m),
      }),
    ).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("ingest failed: ingest endpoint down");
  });

  it("POSTs the report with a bearer key on the happy path", async () => {
    const calls: Array<{ url: string; body: string; auth: string | undefined }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ url: String(url), body: String(init?.body), auth: headers.authorization });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await postIngest(passWithDivergence, "/nonexistent-artifacts-dir", {
      ingestUrl: "https://ingest.example.com/runs",
      ingestKey: "secret",
      fetchImpl,
      log: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe("Bearer secret");
    const payload = JSON.parse(calls[0]!.body) as { report: RunReport; artifacts: string[] };
    expect(payload.report.run_id).toBe(passWithDivergence.run_id);
    expect(payload.artifacts).toEqual([]);
  });
});
