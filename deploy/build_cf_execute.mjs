// Emits a Cloudflare-API `execute` async function that deploys worker.js and its src/rro_*.js modules to
// parish-statutory-almanac with the RRO_CHECKOUT_DB D1 binding. Existing non-secret bindings are read from the
// script's current settings and preserved; secrets are kept via keep_bindings. Every API response is checked.
// Contains no secrets.
import { readFileSync } from "node:fs";
const MODULES = ["worker.js", "src/rro_core.js", "src/rro_checkout.js", "src/rro_pages.js"];
const files = Object.fromEntries(MODULES.map((m) => [m, readFileSync(new URL("../" + m, import.meta.url), "utf8")]));
const message = process.argv[2] || "rro stripe checkout";
process.stdout.write(`async () => {
  const files = ${JSON.stringify(files)};
  const SCRIPT = "parish-statutory-almanac";
  const DB_NAME = "parish-rro-checkout";
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
  return { d1: db.uuid, kept_bindings: existing.map((b) => b.type + ":" + b.name), etag: up && up.etag, modified_on: up && up.modified_on };
}
`);
