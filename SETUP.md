# SETUP — Repo Settings Checklist

Apply these once from a machine with `gh` CLI authenticated as Plumbline-Studio.
(These settings are not exposed through the chat connector; this file is the handoff.)

## 1. Branch protection on main

```bash
gh api -X PUT repos/Plumbline-Studio/Plumb-bob/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

After Plumb Bob v1 self-runs green, add itself as a required check:

```bash
gh api -X PATCH repos/Plumbline-Studio/Plumb-bob/branches/main/protection/required_status_checks \
  -f strict=true -f "contexts[]=plumb-bob"
```

## 2. Security features

```bash
gh api -X PATCH repos/Plumbline-Studio/Plumb-bob \
  -F security_and_analysis[secret_scanning][status]=enabled \
  -F security_and_analysis[secret_scanning_push_protection][status]=enabled
gh api -X PUT repos/Plumbline-Studio/Plumb-bob/vulnerability-alerts
```

Dependabot updates: commit `.github/dependabot.yml` (npm, weekly) during the engine session.

## 3. Actions permissions

```bash
gh api -X PUT repos/Plumbline-Studio/Plumb-bob/actions/permissions/workflow \
  -f default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=false
```

Grant `pull-requests: write` per-job in workflow YAML only (the comment-posting job).

## 4. CODEOWNERS

Committed at `.github/CODEOWNERS` (Kyle owns `*`). No action needed.

## 5. Releases

```bash
git tag v1.0.0 && git push origin v1.0.0
git tag -f v1 && git push -f origin v1     # floating major tag consumers pin
```

## Standing rules

- Repo stays **private**; no license file until productization decision.
- **Zero secrets in this repo** — all keys arrive as Action inputs from consumer repos.
- Breaking schema change = major version bump on schema AND Action tag together.
