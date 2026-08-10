/**
 * site-diverged: submit works, but an extra "Join our newsletter" interstitial
 * appears before the confirmation — behavior differs from the playscript
 * without breaking the flow.
 *
 * Same agent as site-green. On the "shows confirmation immediately" System
 * step it honestly reports the newsletter page it observed (→ divergence +
 * Matthies question), then, like any human tester, dismisses the interstitial
 * via "No thanks" to complete the rest of the script. Golden: System step 6
 * diverges, level status "divergence", run result "pass".
 */

import { makeLanternPolicy, type PolicyFn } from "./common.js";

export const makePolicy = (): PolicyFn => makeLanternPolicy({ shopperName: "Avery Detour" });
