// node --test tests/  — P63 (money alerts never throttled), P64 (deploy refuses without a readable rollback
// target), P61 (deploy sets and verifies the Workers Logs privacy config; mismatch = stop + roll back). No network.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rroAlert, rroResetIsolateStateForTests, RRO_ALERT_EVENT, RRO_ALERT_UNTHROTTLED } from "../src/rro_core.js";
import { captureLogs } from "./rro_batch_helpers.mjs";

const alerts = (logs) => logs.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((j) => j && j.event === RRO_ALERT_EVENT);

// ---------------------------------------------------------------- P63
test("P63: webhook_record_failed, pack_record_failed and webhook_paid_row_missing are never throttled; others still are", async () => {
  rroResetIsolateStateForTests();
  assert.deepEqual([...RRO_ALERT_UNTHROTTLED].sort(), ["pack_record_failed", "webhook_paid_row_missing", "webhook_record_failed"]);
  const t0 = 1_800_000_000_000;
  const logs = await captureLogs(async () => {
    for (let i = 0; i < 5; i++) {
      for (const a of RRO_ALERT_UNTHROTTLED) assert.equal(rroAlert(a, { mode: "test" }, t0 + i), true);
      rroAlert("webhook_signature_failed", { mode: "test" }, t0 + i);
    }
  });
  const a = alerts(logs);
  for (const name of RRO_ALERT_UNTHROTTLED) assert.equal(a.filter((x) => x.alert === name).length, 5, name);
  assert.equal(a.filter((x) => x.alert === "webhook_signature_failed").length, 1);
  assert.ok(a.every((x) => x.suppressed === undefined || x.alert === "webhook_signature_failed"));
});

// ---------------------------------------------------------------- deploy harness (P64, P61)
const build = () => execFileSync(process.execPath, [new URL("../deploy/build_cf_execute.mjs", import.meta.url).pathname, "p61 test"], { encoding: "utf8" });
const NAMES = [{ type: "secret_text", name: "RRO_IP_PEPPER" }, { type: "secret_text", name: "RRO_TELEMETRY_TOKEN" }];
export const GOOD_OBS = { enabled: true, head_sampling_rate: 1, redact_query_string: true, logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: false }, traces: { enabled: false, persist: true, head_sampling_rate: 1 } };
function runDeploy(src, { deps = { success: true, result: { deployments: [{ id: "d-prev", versions: [{ version_id: "v-prev", percentage: 100 }] }] } }, obsAfter = GOOD_OBS, patchOk = true } = {}) {
  const calls = [];
  let schedules = [];
  const cloudflare = { request: async ({ method, path, body }) => {
    calls.push({ m: method, p: path, body });
    if (path.endsWith("/script-settings")) return method === "PATCH" ? (patchOk ? { success: true, result: {} } : { success: false, errors: [{ code: 10000, message: "denied" }] }) : { success: true, result: { observability: obsAfter, logpush: false } };
    if (path.endsWith("/settings")) return { success: true, result: { bindings: NAMES } };
    if (path.endsWith("/d1/database")) return { success: true, result: [{ name: "parish-rro-checkout", uuid: "u-1" }] };
    if (path.endsWith("/deployments") && method === "GET") return typeof deps === "function" ? deps() : deps;
    if (path.endsWith("/deployments") && method === "POST") return { success: true, result: { id: "d-rb" } };
    if (path.endsWith("/schedules") && method === "PUT") { schedules = body; return { success: true, result: { schedules } }; }
    if (path.endsWith("/schedules")) return { success: true, result: { schedules } };
    return { success: true, result: { etag: "e" } };
  } };
  const fn = new Function("cloudflare", "accountId", "FormData", "Blob", "return (" + src + ")")(cloudflare, "acct", FormData, Blob);
  return { calls, done: fn() };
}
const writes = (calls) => calls.filter((c) => c.m !== "GET");

// ---------------------------------------------------------------- P64
test("P64: the deploy refuses (nothing written) when the rollback target cannot be read; no silent manual fallback", async () => {
  const src = build();
  assert.doesNotMatch(src, /no previous version known/);
  const cases = [
    { success: false, errors: [{ code: 10000, message: "auth" }] },
    { success: true, result: { deployments: [] } },
    { success: true, result: { deployments: [{ id: "d", versions: [{ version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 }] }] } },
    () => { throw new Error("network"); },
  ];
  for (const deps of cases) {
    const d = runDeploy(src, { deps });
    await assert.rejects(d.done, /rollback target|network/);
    assert.equal(writes(d.calls).length, 0, "nothing written");
  }
  const ok = runDeploy(src);
  await ok.done;
  const tail = src.slice(src.lastIndexOf("const SCRIPT ="));
  assert.ok(tail.indexOf('"read rollback target"') < tail.indexOf('"list D1"'), "rollback target read before any write");
});
