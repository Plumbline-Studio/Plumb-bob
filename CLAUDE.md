# Plumb-bob — agent instructions

## What this repo is

The **specification** for Plumb Bob, Plumbline Studio's agentic PR-verification
engine (Plumb / Level / True). Today it holds the report contract, the
Playscript spec, the principles corpus, and pre-written consumer docs — **no
engine code and no `action.yml`**. The README status banner is the source of
truth for what exists; keep it accurate. This spec is cross-linked from other
repos, so never let the docs imply the Action is installable before it is.

## Docs discipline (platform rule — keep in every project)

- Update `README.md` and `CHANGELOG.md` in the same PR as every behavior change
  — and in this repo, "behavior" includes the schema and the principles corpus.
  A breaking schema change = major version bump on schema AND Action tag together.
- The README describes what exists, not what's planned; planned design lives
  under clearly-labeled "target design" headings.
- `plumbline.json` declares this repo's surfaces and stage. When the engine
  ships, flip stage from `scaffold` and update the manifest in the same PR.
- Verify before push; if your environment can't run checks, say so in the PR.
- Zero secrets in this repo — all keys arrive as Action inputs from consumer
  repos. Never reproduce credential values in code, docs, commits, or PR bodies.

## Two-key rule

Agents working unattended **open PRs and never merge**. Every merge has a human
behind it. Never push to `main`. Never create or modify files under
`.github/workflows/` — parked workflow copies live at `ops/*.workflow.yml` for a
human to move.

## Loose ends (from the Plumbline dashboard)

At session start, list the open GitHub issues labeled `loose-end` on this repo and offer to pick one up. These are notes Kyle captured from dashboard.toolwright.dev — the context for each lives in the issue body. When one is finished, close the issue.
