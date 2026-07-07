# Plumb Bob — Build Brief v2 (Claude Code)

**Plumbline Studio · "Build it true."**
**This repo:** the reusable verification engine. Product repos consume it via `uses: Plumbline-Studio/Plumb-bob@v1`. Nothing product-specific lands here.

## Architecture rule

| Lives HERE (engine) | Lives in each product repo (context) |
|---|---|
| Agent engine + Playwright MCP orchestration (`/engine`) | `/plumb-bob/playscripts/*.md` |
| Playscript format spec (`/schema/playscript.spec.md`) | Principles overlay (product-specific checks/vetoes) |
| Core Plumbline principles (`/principles-core`) | `plumb-bob.config.json` |
| Report contract (`/schema/run.schema.json`) | All repo secrets |
| Reusable Action (`action.yml`) | One workflow file calling `@v1` |

## Three layers, one run

1. **Plumb (functional)** — Claude + Playwright MCP pursues goals against the preview deploy. Screenshots, reasoning, pass/fail.
2. **Level (procedural)** — executes the flow's Playscript step by step; flags divergence between documented and built system. Divergence rule (Matthies): name the step, ask *"script wrong or build wrong?"* — human decides. Nothing drifts silently.
3. **True (principled)** — no-browser pass scoring the diff + screenshots against `/principles-core`: −2..+3 per heuristic, citations required, integrity veto = merge-blocking regardless of functional green.

## Action interface (`action.yml`)

Inputs: `preview_url`, `config_path` (default `plumb-bob/plumb-bob.config.json`), `anthropic_api_key`, `supabase_url` + `supabase_service_key` (optional, read-only persistence checks), `posthog_api_key` (optional), `ingest_url` + `ingest_key` (optional, Console), `layers` (default `plumb,level,true`), `max_steps`.

Outputs: `result` (pass|fail|veto), `report_path`, `run_id`.

Behavior: run three passes → write `run.json` (validates against `/schema/run.schema.json`) + screenshots to workflow artifacts → post ONE PR comment → failing check on functional fail OR veto. If `ingest_url` set, POST report + artifacts to Console; ingest failure never fails the run (viewer is downstream, never a gate).

## Engine build order (Claude Code session)

1. `/engine/run.ts` orchestrator — sequential Plumb → Level → True, assembles report via `report.ts`
2. `/engine/plumb.ts` — Anthropic API + Playwright MCP loop, goal-directed, per-goal screenshot capture
3. `/engine/level.ts` — Playscript parser (per `/schema/playscript.spec.md`) + step executor + divergence detector
4. `/engine/true.ts` — single Anthropic call: diff + screenshots + principles-core + overlay → scores/vetoes JSON
5. `/engine/report.ts` + `/engine/notify.ts` (PR comment renderer, optional ingest POST)
6. `action.yml` composite wiring, then self-test against an OWT preview
7. Tag `v1.0.0`, create floating `v1` tag
8. Apply `SETUP.md` settings via `gh` CLI
9. Install into OWT per `INSTALL.md`; reconcile the example onboarding Playscript against the canonical 11-screen flow docs — the Playscript is source of truth thereafter

## Report contract

`/schema/run.schema.json` is the API. The Console (`plumb-bob-console`, separate repo) never parses prose. Additive changes bump minor; breaking changes bump major + Action major tag together.

## Out of scope (v1)

Parallel execution, mobile-shell testing, the Console, MBC/Bootlegger rollout (after two green weeks on OWT), any UI.

---
*Plumbline Studio · Est. 2026 · Build it true.*
