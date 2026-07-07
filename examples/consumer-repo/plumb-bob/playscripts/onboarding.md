PLAYSCRIPT: New User Onboarding
Purpose: A new visitor completes onboarding, a profile row persists
(migration 0011), analytics fire, and the soft paywall behaves as
designed — dismissible, not blocking.

⚠ SCAFFOLD — reconcile against the canonical 11-screen onboarding flow
docs before first run, then this Playscript is source of truth.

 1. User    Opens preview URL as a fresh session (no cookies).
 2. System  Displays welcome screen with brand tokens applied
            (copper on near-black; flag any default-theme leakage).
 3. User    Advances through value-proposition screens.
 4. System  Each screen renders without layout shift or dead CTAs.
 5. User    Creates an account (test credentials from config).
 6. System  Auth succeeds; session established.
 7. Bob     Verifies profile row written per migration 0011
            (Supabase read-only check).
 8. User    Completes profile and interest steps.
 9. System  Presents Founding Member offer and soft paywall.
10. User    Dismisses the paywall without paying.
11. System  Allows continuation to the social feed home screen.
            (Hard-block here = FAIL — violates soft-paywall design.)
12. Bob     Verifies PostHog onboarding events fired with correct
            properties (per Session 2 instrumentation).
13. Bob     Verifies no RevenueCat entitlement was granted.
14. User    Kills session and reopens the app.
15. System  User lands authenticated on feed; onboarding does not replay.
