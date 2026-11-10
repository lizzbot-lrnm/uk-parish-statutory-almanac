// node --test tests/  — P51 (paid buyer never refused on D1 write failure), P54 (deploy guard order, live-flag
// refusal, stop-and-roll-back, no response echo), P55 (alert throttle), P56 (doc line). No network.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import worker from "../worker.js";
import { rroAlert, RRO_ALERT_EVENT, RRO_ALERT_THROTTLE_MS, rroResetIsolateStateForTests } from "../src/rro_core.js";
import { IP, configuredEnv, get, stripeCalls, mockStripe, noStripe, jsonResp, paidSession, seedStart, captureLogs, withNow } from "./rro_batch_helpers.mjs";

const alerts = (logs) => logs.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((j) => j && j.event === RRO_ALERT_EVENT);
const WRITE = /^\s*(INSERT|UPDATE|DELETE|CREATE)/i;
// Wraps the fake D1 so writes throw (quota exhausted / D1 write outage) while reads keep working.
function writesFail(db, only = WRITE) {
  return {
    ...db,
    prepare: (sql) => {
      if (!only.test(sql)) return db.prepare(sql);
      const boom = async () => { throw new Error("D1_ERROR: write quota exceeded"); };
      const st = { bind: () => st, run: boom, first: boom, all: boom };
      return st;
    },
    batch: async () => { throw new Error("D1_ERROR: write quota exceeded"); },
  };
}
const seedPaid = (e, sid) => e.RRO_CHECKOUT_DB._db.prepare("INSERT INTO rro_checkout_events (kind, stripe_mode, session_id, ip_hash, amount_total, currency, created_at_utc) VALUES ('paid','test',?,NULL,2400,'gbp',?)").run(sid, new Date().toISOString());

// ---------------------------------------------------------------- P51
test("P51: Stripe confirms paid but the paid-row INSERT fails -> the buyer still gets the pack (200), plus a pack_record_failed alert", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P51RECORDFAIL0000001";
  seedStart(e, sid);
  mockStripe(() => jsonResp(paidSession(sid)));
  const env2 = { ...e, RRO_CHECKOUT_DB: writesFail(e.RRO_CHECKOUT_DB, /VALUES \('paid'/) };
  let r;
  const logs = await captureLogs(async () => { r = await worker.fetch(get("/api/rro/pack?session_id=" + sid), env2); });
  assert.equal(r.status, 200, "never a 500 once Stripe says paid");
  assert.equal(stripeCalls.length, 1);
  const a = alerts(logs).find((x) => x.alert === "pack_record_failed");
  assert.ok(a && /write quota/.test(a.error));
  assert.ok(!logs.some((l) => l.includes(sid) || l.includes(IP)), "no session id or IP in logs");
  const ok = await worker.fetch(get("/rro/pack/success?session_id=" + sid), env2);
  assert.equal(ok.status, 200, "success page also served from the paid cache");
});

test("P51: ALL D1 writes failing, session already recorded paid -> counters fail open for it and the pack is served", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P51ALLWRITESPAID0001";
  seedStart(e, sid);
  seedPaid(e, sid);
  mockStripe(() => jsonResp(paidSession(sid)));
  const env2 = { ...e, RRO_CHECKOUT_DB: writesFail(e.RRO_CHECKOUT_DB) };
  let r;
  const logs = await captureLogs(async () => { r = await worker.fetch(get("/api/rro/pack?session_id=" + sid), env2); });
  assert.equal(r.status, 200);
  const names = alerts(logs).map((x) => x.alert);
  assert.ok(names.includes("pack_counter_write_failed"));
  assert.equal(alerts(logs).find((x) => x.alert === "pack_counter_write_failed").paid, true);
});

test("P51: ALL D1 writes failing, session NOT paid -> fails closed (generic 503), Stripe never called", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P51ALLWRITESUNPAID01";
  seedStart(e, sid);
  noStripe();
  const env2 = { ...e, RRO_CHECKOUT_DB: writesFail(e.RRO_CHECKOUT_DB) };
  let r;
  const logs = await captureLogs(async () => { r = await worker.fetch(get("/api/rro/pack?session_id=" + sid), env2); });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { status: "error", error: "UNAVAILABLE" });
  assert.equal(stripeCalls.length, 0);
  assert.equal(alerts(logs).find((x) => x.alert === "pack_counter_write_failed").paid, false);
  // A random (unknown) id is still a plain 404 from the read, with no write attempted.
  const u = await worker.fetch(get("/api/rro/pack?session_id=cs_test_P51UNKNOWN00000001"), env2);
  assert.equal(u.status, 404);
});

// ---------------------------------------------------------------- P54
const build = (...args) => execFileSync(process.execPath, [new URL("../deploy/build_cf_execute.mjs", import.meta.url).pathname, "p54 test", ...args], { encoding: "utf8" });
const PEPPER = { type: "secret_text", name: "RRO_IP_PEPPER" };
const TOKEN = { type: "secret_text", name: "RRO_TELEMETRY_TOKEN" };
function runDeploy(src, { before = [PEPPER, TOKEN], after = before, rollbackOk = true, settingsResp = null } = {}) {
  const calls = [];
  let reads = 0;
  let schedules = [];
  const cloudflare = { request: async ({ method, path, body }) => {
    calls.push({ m: method, p: path, body });
    if (path.endsWith("/settings")) return settingsResp || { success: true, result: { bindings: reads++ === 0 ? before : after } };
    if (path.endsWith("/d1/database")) return { success: true, result: [{ name: "parish-rro-checkout", uuid: "u-1" }] };
    if (path.endsWith("/deployments") && method === "GET") return { success: true, result: { deployments: [{ id: "d-prev", versions: [{ version_id: "v-prev", percentage: 100 }] }] } };
    if (path.endsWith("/deployments") && method === "POST") return rollbackOk ? { success: true, result: { id: "d-rb" } } : { success: false, errors: [{ code: 10000, message: "denied" }] };
    if (path.endsWith("/schedules") && method === "PUT") { schedules = body; return { success: true, result: { schedules } }; }
    if (path.endsWith("/schedules")) return { success: true, result: { schedules } };
    return { success: true, result: { etag: "e" } };
  } };
  const fn = new Function("cloudflare", "accountId", "FormData", "Blob", "return (" + src + ")")(cloudflare, "acct", FormData, Blob);
  return { calls, done: fn() };
}
const writes = (calls) => calls.filter((c) => c.m !== "GET");
const UPLOAD = (c) => c.m === "PUT" && c.p === "/accounts/acct/workers/scripts/parish-statutory-almanac";

test("P54: the pepper and live-flag preflight run before ANY write, including the D1 list/create", async () => {
  const src = build();
  const tail = src.slice(src.lastIndexOf("const SCRIPT ="));
  const at = (s) => { const i = tail.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at("not bound") < at('"list D1"') && at("was not made with --live") < at('"list D1"') && at('"list D1"') < at('"upload")'));
  const m = runDeploy(src, { before: [TOKEN] });
  await assert.rejects(m.done, /RRO_IP_PEPPER \(nothing written\)/);
  assert.deepEqual(m.calls.map((c) => c.m + " " + c.p), ["GET /accounts/acct/workers/scripts/parish-statutory-almanac/settings"], "only the settings read happened");
});

test("P54: a binding named RRO_STRIPE_LIVE_ENABLED makes the deploy refuse unless the payload was built with --live", async () => {
  for (const type of ["plain_text", "secret_text"]) {
    const d = runDeploy(build(), { before: [PEPPER, TOKEN, { type, name: "RRO_STRIPE_LIVE_ENABLED" }] });
    await assert.rejects(d.done, /RRO_STRIPE_LIVE_ENABLED is present .* not made with --live \(nothing written\)/);
    assert.equal(writes(d.calls).length, 0);
  }
  const live = build("--live");
  assert.match(live, /const LIVE_ALLOWED = true;/);
  assert.match(build(), /const LIVE_ALLOWED = false;/);
  const ok = runDeploy(live, { before: [PEPPER, TOKEN, { type: "secret_text", name: "RRO_STRIPE_LIVE_ENABLED" }] });
  const out = await ok.done;
  assert.ok(ok.calls.some(UPLOAD));
  assert.deepEqual(out.secret_names, ["RRO_IP_PEPPER", "RRO_STRIPE_LIVE_ENABLED", "RRO_TELEMETRY_TOKEN"]);
  assert.match(live, /"workers\/message": "p54 test"/, "--live is a flag, never the deploy message");
});

test("P54: secret names changing during the deploy -> STOP and roll back to the previously serving version", async () => {
  const d = runDeploy(build(), { after: [PEPPER] });
  await assert.rejects(d.done, /secret names changed: .*; STOP, rolled back to v-prev/);
  const rb = d.calls.find((c) => c.m === "POST" && c.p.endsWith("/deployments"));
  assert.ok(rb, "rollback deployment created");
  assert.deepEqual(rb.body.versions, [{ version_id: "v-prev", percentage: 100 }]);
  assert.ok(d.calls.indexOf(rb) > d.calls.findIndex(UPLOAD));
  assert.ok(!d.calls.some((c) => c.p.endsWith("/schedules") && c.m === "PUT"), "nothing further after the stop");
  const f = runDeploy(build(), { after: [PEPPER], rollbackOk: false });
  await assert.rejects(f.done, /ROLLBACK FAILED .*roll back to v-prev by hand/);
});

test("P54: API errors echo only errors/messages, never a whole response (no binding values can leak)", async () => {
  const d = runDeploy(build(), { settingsResp: { success: false, errors: [{ code: 7003, message: "no route" }], result: { bindings: [{ type: "plain_text", name: "X", text: "SENSITIVE-VALUE-123" }] } } });
  const err = await d.done.then(() => null, (e) => e);
  assert.ok(err);
  assert.match(err.message, /read settings failed: \{"errors":\[\{"code":7003,"message":"no route"\}\],"messages":\[\]\}/);
  assert.doesNotMatch(err.message, /SENSITIVE-VALUE-123|plain_text/);
  assert.equal(writes(d.calls).length, 0);
});

// ---------------------------------------------------------------- P55
test("P55: alert lines are throttled per type per isolate, one type never hides another, and carry a suppressed count", async () => {
  rroResetIsolateStateForTests();
  const t0 = 1_800_000_000_000;
  const logs = await captureLogs(async () => {
    for (let i = 0; i < 50; i++) rroAlert("webhook_signature_failed", { mode: "test" }, t0 + i * 100);
    rroAlert("webhook_record_failed", { mode: "test", error: "x" }, t0 + 5000);
    rroAlert("webhook_signature_failed", { mode: "test" }, t0 + RRO_ALERT_THROTTLE_MS + 1);
  });
  const a = alerts(logs);
  assert.deepEqual(a.map((x) => x.alert), ["webhook_signature_failed", "webhook_record_failed", "webhook_signature_failed"]);
  assert.equal(a[0].suppressed, undefined);
  assert.equal(a[2].suppressed, 49);
  assert.equal(RRO_ALERT_THROTTLE_MS, 60000);
});

test("P55: a flood of unsigned webhooks writes one alert line per window through the real route", async () => {
  const e = configuredEnv();
  noStripe();
  const logs = await captureLogs(async () => {
    for (let i = 0; i < 30; i++) {
      const r = await worker.fetch(new Request("https://parish.technoplusit.co.uk/api/rro/stripe-webhook", { method: "POST", headers: { "Stripe-Signature": "t=1,v1=00", "Content-Type": "application/json" }, body: "{}" }), e);
      assert.equal(r.status, 400);
    }
  });
  assert.equal(alerts(logs).filter((x) => x.alert === "webhook_signature_failed").length, 1);
  const later = await withNow(Date.now() + RRO_ALERT_THROTTLE_MS + 5, () => captureLogs(async () => {
    await worker.fetch(new Request("https://parish.technoplusit.co.uk/api/rro/stripe-webhook", { method: "POST", headers: { "Stripe-Signature": "t=1,v1=00", "Content-Type": "application/json" }, body: "{}" }), e);
  }));
  assert.equal(alerts(later).find((x) => x.alert === "webhook_signature_failed").suppressed, 29);
});

// ---------------------------------------------------------------- P56
test("P56: the configuration table says pack/success return 503 UNAVAILABLE without the pepper; only checkout says CHECKOUT_NOT_CONFIGURED", () => {
  const doc = readFileSync(new URL("../deploy/RRO_STRIPE_CHECKOUT.md", import.meta.url), "utf8");
  const row = doc.split("\n").find((l) => l.startsWith("| `RRO_IP_PEPPER` |"));
  assert.ok(row);
  assert.match(row, /checkout returns `503 CHECKOUT_NOT_CONFIGURED`/);
  assert.match(row, /`\/api\/rro\/pack` and `\/rro\/pack\/success` return the generic `503 UNAVAILABLE`/);
  assert.doesNotMatch(row, /pack lookups return `503 CHECKOUT_NOT_CONFIGURED`/);
});
