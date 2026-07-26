#!/usr/bin/env node
/**
 * Plumbline gate runner (Brief 4). Reads plumbline.json, runs universal +
 * surface-keyed checks. No dependencies — plain Node.
 *
 * Universal: typecheck/lint/test (when an app exists) · playscript format ·
 * secret scan. Surface-keyed: auth→RLS in migrations · webhooks→signature
 * verification present · payments→strict secrets + payment playscript veto.
 *
 * GATE_REPORT_ONLY=1 → report, exit 0 (legacy on-ramp, protocol §3).
 */
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const reportOnly = process.env.GATE_REPORT_ONLY === "1";
const results = []; // {name, status: pass|fail|skip, detail}
const add = (name, status, detail = "") => results.push({ name, status, detail });

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", ".next", "out", "build"].includes(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// --- manifest ---------------------------------------------------------------
let manifest = { slug: "?", surfaces: [], stage: "scaffold" };
try {
  manifest = JSON.parse(readFileSync(join(root, "plumbline.json"), "utf8"));
  add("manifest", "pass", `slug=${manifest.slug} surfaces=[${(manifest.surfaces||[]).join(",")}] stage=${manifest.stage}`);
} catch {
  add("manifest", "fail", "plumbline.json missing or invalid — every repo declares its surfaces");
}
const surfaces = manifest.surfaces ?? [];
const hasApp = existsSync(join(root, "package.json"));

// --- universal: app checks --------------------------------------------------
function runScript(name) {
  if (!hasApp) return add(name, "skip", "no app yet (docs/platform-layer stage)");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!pkg.scripts?.[name]) return add(name, "skip", `no "${name}" script`);
  try {
    execSync(`npm run ${name}`, { stdio: "pipe", cwd: root });
    add(name, "pass");
  } catch (e) {
    add(name, "fail", String(e.stdout || e.message).split("\n").slice(-15).join("\n"));
  }
}
runScript("typecheck");
runScript("lint");
runScript("test");

// --- universal: playscripts -------------------------------------------------
const psDir = join(root, "playscripts");
const playscripts = existsSync(psDir)
  ? readdirSync(psDir).filter((f) => f.endsWith(".playscript.md") && !f.startsWith("_"))
  : [];
if (manifest.stage === "scaffold" && playscripts.length === 0) {
  add("playscripts", "skip", "scaffold stage — first playscript before first feature");
} else if (playscripts.length === 0) {
  add("playscripts", "fail", "no playscripts beyond scaffold stage — spec before build");
} else {
  const missingVeto = playscripts.filter((f) => {
    const text = readFileSync(join(psDir, f), "utf8");
    return !(/integrity veto/i.test(text) && /\*\*[^*]*never/i.test(text));
  });
  if (missingVeto.length) add("playscripts", "fail", `missing integrity veto: ${missingVeto.join(", ")}`);
  else add("playscripts", "pass", `${playscripts.length} playscript(s), all carry vetoes`);
}

// --- universal: secret scan -------------------------------------------------
const SECRET_PATTERNS = [
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "private key material"],
  [/sk_live_[a-zA-Z0-9]{10,}/, "live Stripe secret key"],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, "hardcoded JWT (service key?)"],
];
const scanFiles = walk(root).filter((f) =>
  /\.(ts|tsx|js|jsx|mjs|json|sql|md|yml|yaml)$/.test(f) &&
  !f.endsWith("run-gates.mjs") && !/\.env\.example$/.test(f) && !/package-lock\.json$/.test(f),
);
const secretHits = [];
for (const f of scanFiles) {
  const text = readFileSync(f, "utf8");
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) secretHits.push(`${f.replace(root + "/", "")}: ${label}`);
  }
}
if (secretHits.length) add("secret-scan", "fail", secretHits.join("\n"));
else add("secret-scan", "pass", `${scanFiles.length} files scanned`);

// --- surface: auth → RLS ----------------------------------------------------
if (surfaces.includes("auth")) {
  const migDir = join(root, "supabase", "migrations");
  if (!existsSync(migDir)) {
    add("auth:rls", hasApp ? "fail" : "skip", hasApp ? "auth declared but no supabase/migrations" : "no app yet");
  } else {
    const sql = readdirSync(migDir).filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(migDir, f), "utf8")).join("\n").toLowerCase();
    if (/rls_auto_enable/.test(sql)) {
      add("auth:rls", "pass", "global rls_auto_enable event trigger present");
    } else {
      const created = [...sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z0-9_]+)/g)].map((m) => m[1]);
      const missing = created.filter((t) => !new RegExp(`alter table (?:public\\.)?${t}[^;]*enable row level security`).test(sql));
      if (missing.length) add("auth:rls", "fail", `tables without RLS: ${missing.join(", ")}`);
      else add("auth:rls", "pass", `${created.length} table(s), all RLS-enabled`);
    }
  }
}

// --- surface: webhooks → signature verification ------------------------------
if (surfaces.includes("webhooks")) {
  const hookFiles = scanFiles.filter((f) => /webhook/i.test(f) && /\.(ts|js|mjs)$/.test(f));
  if (!hookFiles.length) {
    add("webhooks:verify", hasApp ? "fail" : "skip", hasApp ? "webhooks declared but no webhook handlers found" : "no app yet");
  } else {
    const unverified = hookFiles.filter((f) => !/verif|constructEvent|signature/i.test(readFileSync(f, "utf8")));
    if (unverified.length) add("webhooks:verify", "fail", `no signature verification: ${unverified.map((f) => f.replace(root + "/", "")).join(", ")}`);
    else add("webhooks:verify", "pass", `${hookFiles.length} handler(s) verify signatures`);
  }
}

// --- surface: payments -------------------------------------------------------
if (surfaces.includes("payments")) {
  const payPs = playscripts.filter((f) => {
    if (/pay|charge|deposit|invoice/i.test(f)) return true;
    const text = readFileSync(join(psDir, f), "utf8");
    return /pay|charge|deposit|invoice/i.test(text);
  });
  if (!payPs.length && manifest.stage !== "scaffold")
    add("payments:playscript", "fail", "payments surface but no payment-flow playscript with a double-charge veto");
  else add("payments:playscript", payPs.length ? "pass" : "skip", payPs.join(", ") || "scaffold stage");
}

// --- report -----------------------------------------------------------------
const failed = results.filter((r) => r.status === "fail");
console.log(`\nPLUMBLINE GATE — ${manifest.slug} (${reportOnly ? "report-only" : "blocking"})\n` + "─".repeat(60));
for (const r of results) {
  const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "·";
  console.log(`${icon} ${r.name.padEnd(22)} ${r.status.toUpperCase()}${r.detail ? " — " + r.detail.split("\n")[0] : ""}`);
  if (r.status === "fail" && r.detail.includes("\n")) console.log(r.detail.split("\n").slice(1).map((l) => "    " + l).join("\n"));
}
console.log("─".repeat(60));
console.log(failed.length ? `${failed.length} gate(s) FAILED` : "All gates green. Build it true.");
process.exit(failed.length && !reportOnly ? 1 : 0);
