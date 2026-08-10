# eval-history — data branch, do not merge

This branch exists to hold **`evals/history.jsonl`**: one provenance-stamped
JSON line per eval-harness run, appended by CI (`harness/append-history.mjs`
via the live-eval workflow).

It lives off `main` so KPI history doesn't add diff noise to the code branch,
and so the CI bot can append without punching a hole in main's branch
protection. **Never merge this branch into `main`.**

Raw read (what the dashboard consumes):

```
https://raw.githubusercontent.com/Plumbline-Studio/Plumb-bob/eval-history/evals/history.jsonl
```

Record shape and how to read the series: `evals/README.md` on `main`.

The code files on this branch are an inert snapshot from when the branch was
cut — ignore them; only `evals/history.jsonl` is maintained here.
