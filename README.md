# Plumb Bob

> **Status: specification stage — the Action is not yet published.**
> There is no `action.yml` in this repo, no engine code, and no `v1` tag.
> `Plumbline-Studio/Plumb-bob@v1` does not exist and cannot be referenced from
> consumer workflows. Everything below describes the **target design**; do not
> link, pin, or install `@v1` anywhere until this banner changes.

**The weight that tests true.** An agentic verification engine by
[Plumbline Studio](https://github.com/Plumbline-Studio). Every pull request
gets dropped against the line three ways:

| Layer | Question |
|---|---|
| **Plumb** | Does it work? Goal-directed agentic browser testing against the preview deploy. |
| **Level** | Does it match the documented system? Executes the flow's [Playscript](schema/playscript.spec.md) (Matthies, 1961) and flags divergence. |
| **True** | Should it exist this way? Scores the change against the [Plumbline principles corpus](principles-core/). Integrity vetoes block merge. |

## What exists today

- `schema/` — the report contract (`run.schema.json`) and the Playscript spec
- `principles-core/` — the principles corpus the True layer will score against
- `docs/BRIEF.md` — the build brief for the engine session
- `examples/` — consumer-repo starting points, written ahead of the build
- `INSTALL.md` / `SETUP.md` — install guide and repo-settings checklist, also written ahead of the build

No runnable engine ships from this repo yet.

## Planned usage (once the engine ships)

Product repos will consume the engine as a reusable GitHub Action:

```yaml
# TARGET DESIGN — does not work today; @v1 has not been published
- uses: Plumbline-Studio/Plumb-bob@v1
  with:
    preview_url: ${{ steps.preview.outputs.url }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

- **Install guide (pre-written, do not follow yet):** [INSTALL.md](INSTALL.md)
- **Build brief (Claude Code):** [docs/BRIEF.md](docs/BRIEF.md)
- **Repo settings to apply:** [SETUP.md](SETUP.md)
- **Report contract:** [schema/run.schema.json](schema/run.schema.json)

## The design intent

Test definitions survive redesigns because the agent pursues intent, not
selectors. Procedures never drift from products because divergence always
surfaces the question: *script wrong, or build wrong?* And nothing ships that
fails the principles — functional green does not override an integrity veto.

---
*Plumbline Studio · Est. 2026 · Build it true.*
