# Installing Plumb Bob in Your Repo

> **Not installable yet.** Plumb Bob is at specification stage — the Action
> (`action.yml`) has not been built and no `@v1` tag exists. This guide is
> written ahead of the build so the consumer experience is designed first.
> Do not follow it until the status banner in [README.md](README.md) changes.

Plumb Bob verifies every pull request three ways: **Plumb** (does it work),
**Level** (does it match the documented system), **True** (should it exist this
way). One workflow file, one config, one Playscript per flow. ~15 minutes.

## Prerequisites

- A web app with preview deploys per PR (Vercel, Cloudflare Pages, Netlify)
- An Anthropic API key
- Optional: Supabase (persistence checks), PostHog (event checks), RevenueCat (entitlement checks)

## Steps

### 1. Add the directory

```
your-repo/
  plumb-bob/
    plumb-bob.config.json
    playscripts/
      <your-first-flow>.md
```

Copy starting points from [`/examples/consumer-repo`](examples/consumer-repo/).
Write your Playscript per [`/schema/playscript.spec.md`](schema/playscript.spec.md)
— numbered steps, one actor + one action each, Actors: User / System / Bob.

### 2. Add secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | Required |
|---|---|
| `ANTHROPIC_API_KEY` | Yes |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Only for Bob persistence steps (use a **read-only** key) |
| `POSTHOG_API_KEY` | Only for Bob analytics steps |

### 3. Add the workflow

Copy [`/examples/consumer-repo/.github/workflows/plumb-bob.yml`](examples/consumer-repo/.github/workflows/plumb-bob.yml)
into your repo, adjust the preview-URL step for your host, commit.

### 4. Open a PR

Plumb Bob runs against the preview deploy and posts one comment: functional
results, Playscript step results with screenshots, principled scores. A red X
means a functional failure **or** an integrity veto.

## When a divergence appears

The comment names the step and asks: **script wrong, or build wrong?**
You decide. Fix the Playscript or fix the build — never let them drift apart.

## Optional: principles overlay

Add `plumb-bob/principles-overlay.md` to layer product-specific heuristics or
vetoes on top of the core corpus. Overlays add; they never remove core vetoes.
