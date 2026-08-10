# evals/ — the KPI series

`harness/append-history.mjs` writes one JSON line per eval run to
`history.jsonl` on the **`eval-history` data branch** (not `main` — history is
data, and data doesn't belong in the code branch's diff noise).

Read it raw:

```
https://raw.githubusercontent.com/Plumbline-Studio/Plumb-bob/eval-history/evals/history.jsonl
```

## Record shape

| field | meaning |
|---|---|
| `ts`, `tier`, `ci_run_id` | when, which tier (mock \| live), which CI run |
| `model`, `engine_sha`, `repo` | **provenance** — makes a dip attributable |
| `accuracy_overall` | share of runs matching their golden (0–1) |
| `consistency_overall` | mean per-variant agreement across repeats (0–1) |
| `all_schema_valid` | every produced report validated against the contract |
| `wall_ms`, `runs_per_variant`, `variant_count` | run shape, for cost/time trend |
| `variants{}` | per-fixture accuracy, consistency, verdict, first mismatch |

## What the two KPIs mean

**Accuracy** — did the verifier reach the right verdict? Falls when the model
misjudges a fixture it used to get right.

**Consistency** — did it reach the *same* verdict across repeats, right or
wrong? This is the agentic-flakiness metric: a system at 100% accuracy and 60%
consistency is not trustworthy, it is lucky. Consistency is the number to watch
first.

## Reading the series

- Establish a baseline before trusting any single run — several runs across a
  few days tell you normal variance; one run tells you almost nothing.
- A drop with an unchanged `model` and `engine_sha` means the vendor moved
  under you. A drop alongside a new `engine_sha` means you did.
- Standing rule (from `harness/README.md`): anything the live tier gets wrong
  becomes a new fixture variant. Find bugs once.
