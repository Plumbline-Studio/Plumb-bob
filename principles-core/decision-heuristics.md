# Decision Heuristics & Integrity Vetoes

The True layer's scoring corpus. Every score cites its heuristic by ID.
Scale: **−2 to +3** per heuristic (matches the Plumbline worthiness scorecard).
**Any veto blocks merge regardless of totals or functional green.**

> Distilled from the Tool Maker philosophy (Infinite Game framework, Sinek) and
> the worthiness scorecard's integrity dimensions (Brown). Kyle: reconcile
> against your canonical philosophy doc before first production run.

## Heuristics (Infinite Game / Tool Maker)

| ID | Heuristic |
|---|---|
| H1 | **Just Cause.** Does this advance "a world where every person pursuing a worthy path has tools well-made enough to keep going"? |
| H2 | **Capability over dependency.** Does this make the user more capable, or more dependent? |
| H3 | **Reach.** Does it make the user reach — or does it reach for them? |
| H4 | **Noise test.** If this feature disappeared tomorrow, would the user be worse off? If not, it's noise. |
| H5 | **Horizon.** Built for next quarter or next decade? Decade wins ties. |
| H6 | **Earned trust.** Have we earned the trust this asks of the user? |
| H7 | **Clarity.** If it needs explaining, the feature — not the copy — needs redesign. |
| H8 | **Borrowed resources.** Does it honor the user's time, attention, and trust as finite resources we are borrowing? |
| H9 | **Craft.** Is the work itself sound? Sloppy work is a small betrayal. |

## Integrity vetoes (Brown-derived)

| ID | Veto | Includes |
|---|---|---|
| V1 | **Dark patterns** | Manufactured urgency, guilt copy, obstructed cancellation or dismissal, confirmshaming |
| V2 | **Dependency loops** | Engagement mechanics rewarding return visits over user outcomes; streaks, variable-reward hooks without user benefit |
| V3 | **Dishonest framing** | Pricing, scarcity, or social proof the data doesn't support |
| V4 | **Trust breach** | Collecting, exposing, or retaining user data beyond what the feature requires |

## Scoring protocol (for /engine/true.ts)

1. Input: PR diff, run screenshots, this file, plus the consumer repo's principles overlay if present (overlay may ADD heuristics/vetoes; it may never remove core ones).
2. Score only heuristics the change plausibly touches; omit the rest (omitted ≠ 0).
3. Every score and veto must cite ID + one-sentence rationale grounded in the diff or a screenshot.
4. Output must validate against `layers.true` in `run.schema.json`.
5. When uncertain between a low score and a veto: score low and flag for human review. Vetoes are for evidence, not vibes.
