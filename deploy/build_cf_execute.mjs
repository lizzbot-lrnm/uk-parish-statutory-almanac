// Emits a Cloudflare-API `execute` async function that deploys worker.js to parish-statutory-almanac
// with the RRO_CHECKOUT_DB D1 binding, preserving existing secrets. Contains no secrets.
import { readFileSync } from "node:fs";
const code = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const message = process.argv[2] || "idea03 stripe checkout";
process.stdout.write(`async () => {
  const code = ${JSON.stringify(code)};
  const DB_NAME = "parish-rro-checkout";
  const list = await cloudflare.request({ method: "GET", path: \`/accounts/\${accountId}/d1/database\`, query: { name: DB_NAME } });
  let db = (list.result || []).find((d) => d.name === DB_NAME);
  if (!db) db = (await cloudflare.request({ method: "POST", path: \`/accounts/\${accountId}/d1/database\`, body: { name: DB_NAME } })).result;
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2026-10-25",
    bindings: [{ type: "d1", name: "RRO_CHECKOUT_DB", id: db.uuid }],
    keep_bindings: ["secret_text", "plain_text"],
    annotations: { "workers/message": ${JSON.stringify(message)} }
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("worker.js", new Blob([code], { type: "application/javascript+module" }), "worker.js");
  const up = await cloudflare.request({ method: "PUT", path: \`/accounts/\${accountId}/workers/scripts/parish-statutory-almanac\`, body: form });
  return { d1: db.uuid, success: up.success, etag: up.result && up.result.etag, modified_on: up.result && up.result.modified_on };
}
`);
