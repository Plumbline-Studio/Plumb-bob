# Playscript Format Specification

Plumb Bob's procedural layer executes **Playscripts** — procedures written in the
format Leslie H. Matthies defined in *The Playscript Procedure* (1961): numbered
steps, exactly one actor and one action per step, written in active voice.

The Playscript is not documentation of the system. **The Playscript IS the system,
documented.** If built behavior diverges, one of them is wrong — the run report
names the step and asks the Matthies question: *script wrong, or build wrong?*
A human decides; the loser gets corrected. Nothing drifts silently.

## File format

One Playscript per flow, in the consumer repo at `plumb-bob/playscripts/<flow>.md`.

```markdown
PLAYSCRIPT: <Flow Name>
Purpose: <One paragraph. What this flow accomplishes and what
"working" means, including out-of-band invariants.>

 1. <Actor>  <One action, active voice.>
 2. <Actor>  <One action.>
 ...
```

## Actors

| Actor | Meaning |
|---|---|
| `User` | The agent acting as a person in the browser |
| `System` | Application behavior the agent must observe/verify |
| `Bob` | Out-of-band verification — database reads, analytics events, entitlement checks |

## Rules

1. **One actor, one action per step.** If a step needs "and," split it.
2. **Active voice, present tense.** "Dismisses the paywall," never "the paywall should be dismissible."
3. **Verifiable actions only.** Every System/Bob step must state something observable.
4. **Failure semantics inline where they matter.** e.g. `(Hard-block here = FAIL)`.
5. **Steps are numbered continuously.** Renumbering is a schema-visible change — divergence records reference step numbers.
6. **The Playscript is source of truth.** Prose docs describe; the Playscript governs. Reconcile once at adoption, then the script leads.

## Execution semantics

- `User` steps: the agent performs the action. Inability to perform = step **fail**.
- `System` steps: the agent verifies the described behavior. Behavior differs = **divergence** (not fail) unless the step declares `= FAIL`.
- `Bob` steps: executed via configured integrations (Supabase read-only, PostHog, RevenueCat). Missing integration config = step **skipped**, noted in report.
- A divergence never auto-fails a run; it surfaces the Matthies question in the report and PR comment. Declared `= FAIL` conditions and `User` step failures fail the run.
