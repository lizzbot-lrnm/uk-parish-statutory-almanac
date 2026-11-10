// Emits a Cloudflare-API `execute` async function that deploys worker.js and its src/rro_*.js modules to
// parish-statutory-almanac with the RRO_CHECKOUT_DB D1 binding. Existing non-secret bindings are read from the
// script's current settings and preserved; secrets are kept via keep_bindings. Every API response is checked.
// Registers the mandatory hourly retention cron and fails the deploy if it is not registered afterwards.
// P40 preflight: refuses to upload unless the secret NAME RRO_IP_PEPPER is bound (names only; values are never
// read), and after the upload checks the set of secret names is unchanged. Contains no secrets.
import { readFileSync } from "node:fs";
const MODULES = ["worker.js", "src/rro_core.js", "src/rro_checkout.js", "src/rro_pages.js"];
const files = Object.fromEntries(MODULES.map((m) => [m, readFileSync(new URL("../" + m, import.meta.url), "utf8")]));
const message = process.argv[2] || "rro stripe checkout";
// Equivalent of wrangler's [triggers] crons = ["0 * * * *"]: hourly retention purge via scheduled().
export const RETENTION_CRON = "0 * * * *";
export const REQUIRED_SECRET_NAMES = ["RRO_IP_PEPPER"];
process.stdout.write(`async () => {
  const files = ${JSON.stringify(files)};
  const SCRIPT = "parish-statutory-almanac";
  const DB_NAME = "parish-rro-checkout";
  const RETENTION_CRON = ${JSON.stringify(RETENTION_CRON)};
  const REQUIRED_SECRET_NAMES = ${JSON.stringify(REQUIRED_SECRET_NAMES)};
  const ok = (r, what) => {
    if (!r || r.success !== true) throw new Error(what + " failed: " + JSON.stringify((r && r.errors) || r));
    return r.result;
  };
  const list = ok(await cloudflare.request({ method: "GET", path: \`/accounts/\${accountId}/d1/database\`, query: { name: DB_NAME } }), "list D1");
  let db = (list || []).find((d) => d.name === DB_NAME);
  if (!db) db = ok(await cloudflare.request({ method: "POST", path: \`/accounts/\${accountId}/d1/database\`, body: { name: DB_NAME } }), "create D1");
  if (!db || !db.uuid) throw new Error("D1 database has no uuid");
  const settings = ok(await cloudflare.request({ method: "GET", path: \`/accounts/\${accountId}/workers/scripts/\${SCRIPT}/settings\` }), "read settings");
  const KEEP_TYPES = ["secret_text", "secret_key"];
  const secretNames = (st) => ((st && st.bindings) || []).filter((b) => KEEP_TYPES.includes(b.type)).map((b) => b.name).sort();
  const secretsBefore = secretNames(settings);
  const missing = REQUIRED_SECRET_NAMES.filter((n) => !secretsBefore.includes(n));
  if (missing.length) throw new Error("preflight: required secret name(s) not bound: " + missing.join(", ") + " (nothing uploaded)");
  const existing = ((settings && settings.bindings) || []).filter((b) => !KEEP_TYPES.includes(b.type) && b.name !== "RRO_CHECKOUT_DB");
  const metadata = {
    main_module: "worker.js",
    compatibility_date: (settings && settings.compatibility_date) || "2026-10-25",
    compatibility_flags: (settings && settings.compatibility_flags) || [],
    bindings: [...existing, { type: "d1", name: "RRO_CHECKOUT_DB", id: db.uuid }],
    keep_bindings: KEEP_TYPES,
    annotations: { "workers/message": ${JSON.stringify(message)} }
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const [name, code] of Object.entries(files)) {
    form.append(name, new Blob([code], { type: "application/javascript+module" }), name);
  }
  const up = ok(await cloudflare.request({ method: "PUT", path: \`/accounts/\${accountId}/workers/scripts/\${SCRIPT}\`, body: form }), "upload");
  const settingsAfter = ok(await cloudflare.request({ method: "GET", path: \`/accounts/\${accountId}/workers/scripts/\${SCRIPT}/settings\` }), "re-read settings");
  const secretsAfter = secretNames(settingsAfter);
  if (JSON.stringify(secretsAfter) !== JSON.stringify(secretsBefore)) throw new Error("smoke: secret names changed: " + JSON.stringify(secretsBefore) + " -> " + JSON.stringify(secretsAfter));
  // Retention cron is mandatory (T3): keep any existing schedules, ensure the hourly purge, then read it back.
  const SCHEDULES = \`/accounts/\${accountId}/workers/scripts/\${SCRIPT}/schedules\`;
  const before = ok(await cloudflare.request({ method: "GET", path: SCHEDULES }), "read schedules");
  const crons = ((before && before.schedules) || []).map((s) => s.cron).filter(Boolean);
  if (!crons.includes(RETENTION_CRON)) crons.push(RETENTION_CRON);
  ok(await cloudflare.request({ method: "PUT", path: SCHEDULES, body: crons.map((cron) => ({ cron })) }), "set schedules");
  const after = ok(await cloudflare.request({ method: "GET", path: SCHEDULES }), "verify schedules");
  const registered = ((after && after.schedules) || []).map((s) => s.cron);
  if (!registered.includes(RETENTION_CRON)) throw new Error("smoke: retention cron " + RETENTION_CRON + " is not registered (got " + JSON.stringify(registered) + ")");
  return { d1: db.uuid, kept_bindings: existing.map((b) => b.type + ":" + b.name), etag: up && up.etag, modified_on: up && up.modified_on, crons: registered, secret_names: secretsAfter };
}
`);
