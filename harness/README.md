# Plumb Bob eval harness

The harness is the product's proof: it measures whether the verification agent
verifies **correctly**, and whether it does so **repeatably**.

## Philosophy

- **Two tiers, one runner.** The `mock` tier drives the real engine, real
  Playwright browser, and real fixture sites with deterministic scripted
  policies through the `ModelClient` seam — it proves the machinery
  (parser → browser → layers → report → schema) end to end, offline, for free.
  The `live` tier runs the same fixtures with the real model, N times, and
  measures **accuracy** (matches the golden) and **consistency** (same
  structural verdict across repeats — agentic flakiness is a first-class
  metric, not noise to ignore).
- **Fixtures drive outcomes; policies never hardcode verdicts.** Every policy
  is the same competent QA agent; it finishes with whatever `read_page`
  actually showed. If a policy could pass without looking at the page, the
  eval would be a tautology.
- **Goldens are structural.** `goldens/<variant>.json` pins result, layer
  statuses, failed/diverged step numbers, veto presence, and a screenshot
  floor (`min_screenshots`) — never prose, which legitimately varies.
- **Every report must validate.** Each produced `report.json` is re-read from
  disk and checked against `schema/run.schema.json`; the harness doubles as
  the report contract's regression suite.

## Running

```sh
npm run harness                       # mock tier: deterministic, offline, exit 1 on any mismatch
npm run harness -- --only site-broken # one variant
PLUMB_BOB_EVAL_TIER=live ANTHROPIC_API_KEY=... npm run harness   # live tier
PLUMB_BOB_EVAL_RUNS=5  # live repeats per variant (default 3)
```

Outputs land in `harness/out/eval-report.json` and `eval-report.md`, with
per-run engine artifacts under `harness/out/<variant>/`.

Cheap fixture guards (no engine layers needed):

```sh
npx vitest run tests/harness-fixtures.test.ts
```

## The variants

| variant | defect | golden |
|---|---|---|
| `site-green` | none | pass / pass / pass |
| `site-broken` | Place Order handler missing — money path dead | fail, User step 5 fails |
| `site-diverged` | newsletter interstitial before confirmation | pass, System step 6 diverges + Matthies question |
| `site-veto` | pre-checked $4.99/mo charge + manufactured urgency | veto (V1/V3 from the True layer); level flags integrity step 8 as failed |

## Adding a fixture

1. Copy `fixtures/site-green/` to `fixtures/site-<name>/`; introduce exactly
   one defect. Keep it static HTML + vanilla JS — no build step.
2. Set `project` in its `plumb-bob/plumb-bob.config.json` to `lantern-<name>`.
   Keep the playscript identical unless the defect is about the script itself —
   one script across variants is the point.
3. Write `goldens/site-<name>.json` (structural fields only).
4. Add a policy in `policies/site-<name>.ts` — export a `makePolicy` factory
   that reuses `makeLanternPolicy` (policies carry run-scoped evidence, so the
   runner builds a fresh one per run) and teach `policies/common.ts` any new
   page state; the policy must derive its verdict from page snapshots, never
   assert it.
5. Register the variant in `eval.ts`'s `VARIANTS` list.
6. Add defect-honesty guards to `tests/harness-fixtures.test.ts` (assert the
   bug is still present in the fixture source).

**Standing rule: every engine bug found in production becomes a new fixture
variant.** Find each bug once; pay for it never again.
