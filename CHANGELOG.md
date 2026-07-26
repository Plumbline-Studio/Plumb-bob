# Changelog

Notable changes to the Plumb Bob spec/engine repo. Newest first.
Discipline: every behavior change (including schema and principles-corpus
changes) updates README + this file in the same PR.

## 2026-07-26 — Vetting: docs truth + platform manifest

- **README.md**: added a status banner — specification stage, no `action.yml`,
  no engine code, no `v1` tag; `Plumbline-Studio/Plumb-bob@v1` must not be
  referenced by consumer workflows yet. The usage snippet is now labeled
  "target design"; added a "What exists today" inventory so the README matches
  the repo's actual contents.
- **INSTALL.md**: added a matching "not installable yet" notice (guide was
  written ahead of the build; content preserved).
- **CLAUDE.md**: added repo scope, docs-discipline, and two-key-rule sections
  from the plumbline-template pattern (loose-ends ritual preserved).
- **plumbline.json** added — `slug: plumb-bob`, no surfaces (no code yet),
  stage `scaffold`.
- **ops/gate/run-gates.mjs** copied from plumbline-template;
  **ops/gate.workflow.yml** parked (a human must move it to
  `.github/workflows/` — the agent token cannot write there). Blocking mode:
  at scaffold stage all gates pass or skip.
- No engine work done — deliberately. `action.yml` is the build session's job
  (see docs/BRIEF.md), not the vetting wave's.
