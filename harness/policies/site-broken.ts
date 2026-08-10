/**
 * site-broken: the Place Order button is dead (its JS handler is missing).
 *
 * Same agent as site-green. The failure verdict must emerge from observation:
 * the agent fills the form, clicks 'Place Order', re-reads the page, sees it
 * never left the order form, and finishes with an honest failure — the money
 * path cannot complete. Golden: User step 5 fails, run result "fail".
 */

import { makeLanternPolicy, type PolicyFn } from "./common.js";

export const makePolicy = (): PolicyFn => makeLanternPolicy({ shopperName: "Avery Broke" });
