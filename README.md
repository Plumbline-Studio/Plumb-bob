# Plumb Bob

**The weight that tests true.** An agentic verification engine by
[Plumbline Studio](https://github.com/Plumbline-Studio). Every pull request
gets dropped against the line three ways:

| Layer | Question |
|---|---|
| **Plumb** | Does it work? Goal-directed agentic browser testing against the preview deploy. |
| **Level** | Does it match the documented system? Executes the flow's [Playscript](schema/playscript.spec.md) (Matthies, 1961) and flags divergence. |
| **True** | Should it exist this way? Scores the change against the [Plumbline principles corpus](principles-core/). Integrity vetoes block merge. |

Product repos consume this engine as a reusable GitHub Action:

```yaml
- uses: Plumbline-Studio/Plumb-bob@v1
  with:
    preview_url: ${{ steps.preview.outputs.url }}
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

- **Install in your repo:** [INSTALL.md](INSTALL.md)
- **Build brief (Claude Code):** [docs/BRIEF.md](docs/BRIEF.md)
- **Repo settings to apply:** [SETUP.md](SETUP.md)
- **Report contract:** [schema/run.schema.json](schema/run.schema.json)

Test definitions survive redesigns because the agent pursues intent, not
selectors. Procedures never drift from products because divergence always
surfaces the question: *script wrong, or build wrong?* And nothing ships that
fails the principles — functional green does not override an integrity veto.

---
*Plumbline Studio · Est. 2026 · Build it true.*
