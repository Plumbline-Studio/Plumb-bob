/**
 * site-green: everything works, nothing manipulates.
 *
 * The policy is the same competent QA agent every variant uses — the passing
 * verdict must come from what the pages actually say (catalog with two priced
 * products, live submit, honest confirmation, no dark-pattern copy), never
 * from this file. One fresh policy per engine run keeps the evidence record
 * scoped to that run.
 */

import { makeLanternPolicy, type PolicyFn } from "./common.js";

export const makePolicy = (): PolicyFn => makeLanternPolicy({ shopperName: "Avery Green" });
