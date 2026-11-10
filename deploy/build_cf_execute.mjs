// Emits a Cloudflare-API `execute` async function that deploys worker.js and its src/rro_*.js modules to
// parish-statutory-almanac with the RRO_CHECKOUT_DB D1 binding. Existing non-secret bindings are read from the
// script's current settings and preserved; secrets are kept via keep_bindings. Every API response is checked.
// Registers the mandatory hourly retention cron and fails the deploy if it is not registered afterwards.
// P40/P54 preflight, before ANY write (D1 create, upload, schedules): refuses unless the secret NAME RRO_IP_PEPPER
// is bound (names only; values are never read), and refuses if a binding named RRO_STRIPE_LIVE_ENABLED exists
// unless the build was made with an explicit --live argument. After the upload, if the set of secret names
// changed it STOPS and rolls back to the version that was serving before (and reports that). P64: if that
// rollback target cannot be read up front, it refuses before writing anything. Error messages
// carry only the API's errors/messages arrays, never a whole response. Contains no secrets.
import { readFileSync } from "node:fs";
const MODULES = ["worker.js", "src/rro_core.js", "src/rro_checkout.js", "src/rro_pages.js"];
const files = Object.fromEntries(MODULES.map((m) => [m, readFileSync(new URL("../" + m, import.meta.url), "utf8")]));
const ARGS = process.argv.slice(2);
const LIVE_ALLOWED = ARGS.includes("--live");
const message = ARGS.find((a) => a !== "--live") || "rro stripe checkout";
// Equivalent of wrangler's [triggers] crons = ["0 * * * *"]: hourly retention purge via scheduled().
export const RETENTION_CRON = "0 * * * *";
export const REQUIRED_SECRET_NAMES = ["RRO_IP_PEPPER"];
export const LIVE_FLAG_NAME = "RRO_STRIPE_LIVE_ENABLED";
process.stdout.write(`async () => {
  const files = ${JSON.stringify(files)};
  const SCRIPT = "parish-statutory-almanac";
  const DB_NAME = "parish-rro-checkout";
  const RETENTION_CRON = ${JSON.stringify(RETENTION_CRON)};
  const REQUIRED_SECRET_NAMES = ${JSON.stringify(REQUIRED_SECRET_NAMES)};
  const LIVE_FLAG_NAME = ${JSON.stringify(LIVE_FLAG_NAME)};
  const LIVE_ALLOWED = ${JSON.stringify(LIVE_ALLOWED)};
  const ok = (r, what) => {
    // P54: only the errors/messages arrays are ever echoed, never the whole response body.
    if (!r || r.success !== true) throw new Error(what + " failed: " + JSON.stringify({ errors: (r && r.errors) || [], messages: (r && r.messages) || [] }));
    return r.result;
  };
  const settings = ok(await cloudflare.request({ method: "GET", path: \`/accounts/\${accountId}/workers/scripts/\${SCRIPT}/settings\` }), "read settings");
  const KEEP_TYPES = ["secret_text", "secret_key"];
  const secretNames = (st) => ((st && st.bindings) || []).filter((b) => KEEP_TYPES.includes(b.type)).map((b) => b.name).sort();
  const secretsBefore = secretNames(settings);
  const missing = REQUIRED_SECRET_NAMES.filter((n) => !secretsBefore.includes(n));
  if (missing.length) throw new Error("preflight: required secret name(s) not bound: " + missing.join(", ") + " (nothing written)");
  const liveFlag = ((settings && settings.bindings) || []).filter((b) => b.name === LIVE_FLAG_NAME).map((b) => b.type);
  if (liveFlag.length && !LIVE_ALLOWED) throw new Error("preflight: binding " + LIVE_FLAG_NAME + " is present (" + liveFlag.join(",") + ") but the build was not made with --live (nothing written)");
  // P64: the rollback target (the version serving 100% right now, ids only) MUST be readable before anything
  // is written: no silent "roll back by hand" fallback. Unreadable or ambiguous -> refuse, nothing written.
  const deps = ok(await cloudflare.request({ method: "GET", path: \`/accounts/\${accountId}/workers/scripts/\${SCRIPT}/deployments\` }), "read rollback target");
  const curDep = deps && Array.isArray(deps.deployments) ? deps.deployments[0] : null;
  const curFull = curDep && (curDep.versions || []).find((x) => Number(x.percentage) === 100);
  const prevVersion = curFull && typeof curFull.version_id === "string" && curFull.version_id ? curFull.version_id : null;
  if (!prevVersion) throw new Error("preflight: rollback target unreadable (no version serving 100%) (nothing written)");
  const rollBack = async (why) => {
    const rb = await cloudflare.request({ method: "POST", path: \`/accounts/\${accountId}/workers/scripts/\${SCRIPT}/deployments\`, body: { strategy: "percentage", versions: [{ version_id: prevVersion, percentage: 100 }], annotations: { "workers/message": "auto-rollback: " + why } } });
    return rb && rb.success === true ? "rolled back to " + prevVersion : "ROLLBACK FAILED (" + JSON.stringify({ errors: (rb && rb.errors) || [] }) + "): roll back to " + prevVersion + " by hand";
  };
  const OBSERVABILITY = { enabled: true, head_sampling_rate: 1, redact_query_string: true, logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: false }, traces: { enabled: false } };
  const obsMismatch = (o) => {
    const bad = [];
    const want = [["enabled", (x) => x.enabled === true], ["head_sampling_rate", (x) => Number(x.head_sampling_rate) === 1], ["redact_query_string", (x) => x.redact_query_string === true],
      ["logs.enabled", (x) => !!x.logs && x.logs.enabled === true], ["logs.invocation_logs", (x) => !!x.logs && x.logs.invocation_logs === false],
      ["logs.head_sampling_rate", (x) => !!x.logs && Number(x.logs.head_sampling_rate) === 1], ["traces.enabled", (x) => !x.traces || x.traces.enabled !== true]];
    for (const [k, f] of want) if (!o || !f(o)) bad.push(k);
    return bad;
  };
  const list = ok(await cloudflare.request({ method: "GET", path: \`/accounts/\${accountId}/d1/database\`, query: { name: DB_NAME } }), "list D1");
  let db = (list || []).find((d) => d.name === DB_NAME);
  if (!db) db = ok(await cloudflare.request({ method: "POST", path: \`/accounts/\${accountId}/d1/database\`, body: { name: DB_NAME } }), "create D1");
  if (!db || !db.uuid) throw new Error("D1 database has no uuid");
  const existing = ((settings && settings.bindings) || []).filter((b) => !KEEP_TYPES.includes(b.type) && b.name !== "RRO_CHECKOUT_DB");
  const metadata = {
    main_module: "worker.js",
    compatibility_date: (settings && settings.compatibility_date) || "2026-10-25",
    compatibility_flags: (settings && settings.compatibility_flags) || [],
    bindings: [...existing, { type: "d1", name: "RRO_CHECKOUT_DB", id: db.uuid }],
    keep_bindings: KEEP_TYPES,
    observability: { enabled: true, head_sampling_rate: 1, logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: false }, traces: { enabled: false } },
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
  if (JSON.stringify(secretsAfter) !== JSON.stringify(secretsBefore)) {
    // P54: STOP and roll back immediately to the version that was serving before this upload.
    throw new Error("smoke: secret names changed: " + JSON.stringify(secretsBefore) + " -> " + JSON.stringify(secretsAfter) + "; STOP, " + (await rollBack("secret names changed during deploy")));
  }
  // Retention cron is mandatory (T3): keep any existing schedules, ensure the hourly purge, then read it back.
  // P61: the deploy sets the Workers Logs privacy config itself and checks it after upload. Invocation logs
  // (visitor IP, user-agent, city/postcode, lat/long) stay OFF; query strings redacted; traces off.
  // Any mismatch (or a failed write/read) = STOP and roll back to the previous version.
  const OBS_PATH = \`/accounts/\${accountId}/workers/scripts/\${SCRIPT}/script-settings\`;
  let obsErr = null, obsGot = null;
  try {
    ok(await cloudflare.request({ method: "PATCH", path: OBS_PATH, body: { observability: OBSERVABILITY } }), "set observability");
    obsGot = (ok(await cloudflare.request({ method: "GET", path: OBS_PATH }), "read observability") || {}).observability || null;
    const bad = obsMismatch(obsGot);
    if (bad.length) obsErr = "observability mismatch: " + bad.join(", ");
  } catch (e) { obsErr = String((e && e.message) || e); }
  if (obsErr) throw new Error("smoke: " + obsErr + "; STOP, " + (await rollBack("observability config check failed")) + " (script-level logs settings are not versioned: re-check them by hand)");
  const SCHEDULES = \`/accounts/\${accountId}/workers/scripts/\${SCRIPT}/schedules\`;
  const before = ok(await cloudflare.request({ method: "GET", path: SCHEDULES }), "read schedules");
  const crons = ((before && before.schedules) || []).map((s) => s.cron).filter(Boolean);
  if (!crons.includes(RETENTION_CRON)) crons.push(RETENTION_CRON);
  ok(await cloudflare.request({ method: "PUT", path: SCHEDULES, body: crons.map((cron) => ({ cron })) }), "set schedules");
  const after = ok(await cloudflare.request({ method: "GET", path: SCHEDULES }), "verify schedules");
  const registered = ((after && after.schedules) || []).map((s) => s.cron);
  if (!registered.includes(RETENTION_CRON)) throw new Error("smoke: retention cron " + RETENTION_CRON + " is not registered (got " + JSON.stringify(registered) + ")");
  return { observability: { enabled: obsGot.enabled, head_sampling_rate: obsGot.head_sampling_rate, redact_query_string: obsGot.redact_query_string, invocation_logs: obsGot.logs.invocation_logs, traces: obsGot.traces ? obsGot.traces.enabled : false }, d1: db.uuid, kept_bindings: existing.map((b) => b.type + ":" + b.name), etag: up && up.etag, modified_on: up && up.modified_on, crons: registered, secret_names: secretsAfter };
}
`);
