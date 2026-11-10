// node --test tests/  — P40 (no-pepper fallback limiter + deploy preflight) and P41 (per-session Stripe budget,
// larger global ceiling, alert log lines). No network: Stripe is mocked through globalThis.fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import worker from "../worker.js";
import {
  rroResetIsolateStateForTests,
  rroWindowStartIso,
  RRO_PUBLIC_RATE_LIMIT,
  RRO_STRIPE_LOOKUP_GLOBAL_CAP,
  RRO_STRIPE_LOOKUP_SESSION_CAP,
  RRO_CHECKOUT_RATE_LIMIT,
  RRO_ALERT_EVENT,
} from "../src/rro_core.js";
import {
  IP,
  configuredEnv,
  disabledEnv,
  get,
  stripeCalls,
  mockStripe,
  noStripe,
  jsonResp,
  paidSession,
  seedStart,
  webhookReq,
  counters,
  withNow,
  captureLogs,
} from "./rro_batch_helpers.mjs";

const alerts = (logs) => logs.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((j) => j && j.event === RRO_ALERT_EVENT);
const windowStart = () => Math.floor(Date.now() / 600000) * 600000 + 1000;

// ---------------------------------------------------------------- P40
test("P40: with no RRO_IP_PEPPER search/calc are still limited per IP (local fallback), with no D1 writes and one alert", async () => {
  const e = disabledEnv({ RRO_IP_PEPPER: undefined });
  const max = RRO_PUBLIC_RATE_LIMIT.max_hits;
  let last;
  const logs = await captureLogs(async () => {
    for (let i = 0; i < max; i++) assert.equal((await worker.fetch(get(i % 2 ? "/api/rro-calculate" : "/api/rro-search?limit=1"), e)).status, 200, "#" + i);
    last = await worker.fetch(get("/api/rro-search?limit=1"), e);
  });
  assert.equal(last.status, 429, "no fail-open without the pepper");
  assert.equal(last.headers.get("Cache-Control"), "no-store");
  assert.ok(Number(last.headers.get("Retry-After")) >= 1);
  assert.deepEqual(await last.json(), { status: "error", error: "RATE_LIMITED" });
  assert.deepEqual(e.RRO_CHECKOUT_DB._writes, [], "fallback never writes to D1");
  const a = alerts(logs).filter((x) => x.alert === "public_rate_limit_fallback");
  assert.equal(a.length, 1, "logged once per isolate");
  assert.equal(a[0].reason, "RRO_IP_PEPPER_MISSING");
  assert.ok(!logs.some((l) => l.includes(IP)), "no raw IP in any log line");
  // Other networks are unaffected; the same /64 shares one fallback bucket.
  assert.equal((await worker.fetch(get("/api/rro-search?limit=1", { "CF-Connecting-IP": "198.51.100.44" }), e)).status, 200);
  for (let i = 0; i < max; i++) await worker.fetch(get("/api/rro-search?limit=1", { "CF-Connecting-IP": "2001:db8:1:2::" + (i + 1).toString(16) }), e);
  assert.equal((await worker.fetch(get("/api/rro-search?limit=1", { "CF-Connecting-IP": "2001:db8:1:2:ffff::9" }), e)).status, 429);
  assert.equal((await worker.fetch(get("/api/rro-search?limit=1", { "CF-Connecting-IP": "2001:db8:1:3::1" }), e)).status, 200);
});

test("P40: the fallback salt is per isolate: a new isolate starts a fresh fallback count (documented scope)", async () => {
  const e = disabledEnv({ RRO_IP_PEPPER: undefined });
  for (let i = 0; i < RRO_PUBLIC_RATE_LIMIT.max_hits; i++) await worker.fetch(get("/api/rro-search?limit=1"), e);
  assert.equal((await worker.fetch(get("/api/rro-search?limit=1"), e)).status, 429);
  rroResetIsolateStateForTests();
  assert.equal((await worker.fetch(get("/api/rro-search?limit=1"), e)).status, 200);
});

const buildSrc = () => execFileSync(process.execPath, [new URL("../deploy/build_cf_execute.mjs", import.meta.url).pathname, "p40 test"], { encoding: "utf8" });
function runDeploy(src, bindingsBefore, bindingsAfter = bindingsBefore) {
  const calls = [];
  let settingsReads = 0;
  let schedules = [];
  const cloudflare = { request: async ({ method, path, body }) => {
    calls.push(method + " " + path);
    if (path.endsWith("/d1/database")) return { success: true, result: [{ name: "parish-rro-checkout", uuid: "u-1" }] };
      if (path.endsWith("/deployments") && method === "GET") return { success: true, result: { deployments: [{ id: "d-prev", versions: [{ version_id: "v-prev", percentage: 100 }] }] } };
    if (path.endsWith("/script-settings")) return method === "PATCH" ? { success: true, result: {} } : { success: true, result: { observability: { enabled: true, head_sampling_rate: 1, redact_query_string: true, logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: false }, traces: { enabled: false } } } };
    if (path.endsWith("/settings")) return { success: true, result: { bindings: settingsReads++ === 0 ? bindingsBefore : bindingsAfter } };
    if (path.endsWith("/schedules") && method === "PUT") { schedules = body; return { success: true, result: { schedules } }; }
    if (path.endsWith("/schedules")) return { success: true, result: { schedules } };
    return { success: true, result: { etag: "e" } };
  } };
  const fn = new Function("cloudflare", "accountId", "FormData", "Blob", "return (" + src + ")")(cloudflare, "acct", FormData, Blob);
  return { calls, done: fn() };
}
const UPLOAD = "PUT /accounts/acct/workers/scripts/parish-statutory-almanac";

test("P40: the deploy refuses to upload when the secret NAME RRO_IP_PEPPER is not bound, and checks names are unchanged after", async () => {
  const src = buildSrc();
  // Read the constant from source (importing the builder would print the whole payload to stdout).
  assert.match(readFileSync(new URL("../deploy/build_cf_execute.mjs", import.meta.url), "utf8"), /export const REQUIRED_SECRET_NAMES = \["RRO_IP_PEPPER"\];/);
  const missing = runDeploy(src, [{ type: "secret_text", name: "RRO_TELEMETRY_TOKEN" }]);
  await assert.rejects(missing.done, /preflight: required secret name\(s\) not bound: RRO_IP_PEPPER \(nothing written\)/);
  assert.ok(!missing.calls.includes(UPLOAD), "no upload without the pepper name");
  const good = [{ type: "secret_text", name: "RRO_IP_PEPPER" }, { type: "secret_text", name: "RRO_TELEMETRY_TOKEN" }];
  const ok = runDeploy(src, good);
  const out = await ok.done;
  assert.deepEqual(out.secret_names, ["RRO_IP_PEPPER", "RRO_TELEMETRY_TOKEN"], "names only");
  assert.ok(ok.calls.includes(UPLOAD));
  const changed = runDeploy(src, good, [good[0]]);
  await assert.rejects(changed.done, /smoke: secret names changed/);
  // The generated function never reads secret values and contains no key-shaped strings.
  assert.doesNotMatch(src, /\/secrets\//);
  assert.doesNotMatch(src, /(sk|rk)_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}/);
});

// ---------------------------------------------------------------- P41
test("P41: each unpaid session gets at most RRO_STRIPE_LOOKUP_SESSION_CAP Stripe GETs per window, then a generic 429 + alert", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P41SESSIONCAP0000001";
  seedStart(e, sid);
  mockStripe(() => jsonResp(paidSession(sid, { payment_status: "unpaid" })));
  const t0 = windowStart();
  const max = RRO_STRIPE_LOOKUP_SESSION_CAP.max_hits;
  for (let i = 0; i < max; i++) {
    // 31 s apart, so the 30 s not-paid cache has expired and each lookup really reaches Stripe.
    const r = await withNow(t0 + i * 31000, () => worker.fetch(get("/api/rro/pack?session_id=" + sid), e));
    assert.equal(r.status, 402, "#" + i);
  }
  assert.equal(stripeCalls.length, max);
  let r;
  const logs = await captureLogs(async () => { r = await withNow(t0 + max * 31000, () => worker.fetch(get("/api/rro/pack?session_id=" + sid), e)); });
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { status: "error", error: "RATE_LIMITED" });
  assert.ok(Number(r.headers.get("Retry-After")) >= 1);
  assert.equal(stripeCalls.length, max, "no Stripe call over the session cap");
  const a = alerts(logs).find((x) => x.alert === "stripe_lookup_session_cap_hit");
  assert.ok(a, "alert line logged");
  assert.equal(a.max, max);
  assert.ok(!logs.some((l) => l.includes(sid)), "no session id in logs");
  const rows = counters(e);
  const srow = rows.find((c) => c.bucket === "stripe_lookup_session");
  assert.equal(srow.n, max, "over the cap nothing more is written");
  assert.ok(!srow.key_hash.includes(sid) && /^[0-9a-f]{32}$/.test(srow.key_hash), "peppered hash, not the raw session id");
  assert.equal(rows.find((c) => c.bucket === "stripe_lookup").n, max, "the global ceiling only counts real Stripe GETs");
});

test("P41: many attacker sessions cannot use up the global ceiling, so a real buyer's lookup still reaches Stripe", async () => {
  // Static bound: sessions needed to reach the ceiling, versus checkout starts one /64 can make per window.
  const sessionsNeeded = Math.ceil(RRO_STRIPE_LOOKUP_GLOBAL_CAP.max_hits / RRO_STRIPE_LOOKUP_SESSION_CAP.max_hits);
  assert.ok(sessionsNeeded >= 200, "needs >= 200 sessions per window");
  assert.ok(sessionsNeeded / RRO_CHECKOUT_RATE_LIMIT.max_starts >= 40, "needs >= 40 distinct /64s per window");
  assert.equal(RRO_STRIPE_LOOKUP_GLOBAL_CAP.window_minutes, RRO_STRIPE_LOOKUP_SESSION_CAP.window_minutes);
  const e = configuredEnv();
  const t0 = windowStart();
  mockStripe(() => jsonResp(paidSession("cs_test_x", { payment_status: "unpaid" })));
  // 12 attacker sessions polled past their budgets from 12 /64s (the old single bucket of 300 fell to ~10-15).
  for (let s = 0; s < 12; s++) {
    const sid = "cs_test_P41ATTACK" + String(s).padStart(11, "0");
    seedStart(e, sid);
    for (let i = 0; i < RRO_STRIPE_LOOKUP_SESSION_CAP.max_hits + 3; i++) {
      await withNow(t0 + i * 31000, () => worker.fetch(get("/api/rro/pack?session_id=" + sid, { "CF-Connecting-IP": "2001:db8:" + s + "::1" }), e));
    }
  }
  const g = counters(e).find((c) => c.bucket === "stripe_lookup").n;
  assert.equal(g, 12 * RRO_STRIPE_LOOKUP_SESSION_CAP.max_hits, "each attacker session is bounded by its own budget");
  assert.ok(g < RRO_STRIPE_LOOKUP_GLOBAL_CAP.max_hits);
  const buyer = "cs_test_P41REALBUYER00000001";
  seedStart(e, buyer);
  mockStripe(() => jsonResp(paidSession(buyer)));
  const r = await withNow(t0 + 400000, () => worker.fetch(get("/api/rro/pack?session_id=" + buyer, { "CF-Connecting-IP": "198.51.100.200" }), e));
  assert.equal(r.status, 200, "real buyer (webhook not yet arrived) still verified via Stripe");
  assert.equal(stripeCalls.length, 1);
});

test("P41: at the global ceiling -> 503 generic UNAVAILABLE, no Stripe call, and a stripe_lookup_global_cap_hit alert", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P41GLOBALCAP00000001";
  seedStart(e, sid);
  e.RRO_CHECKOUT_DB._db.prepare("INSERT INTO rro_rate_counters (bucket, key_hash, window_start_utc, n) VALUES ('stripe_lookup','global',?,?)")
    .run(rroWindowStartIso(RRO_STRIPE_LOOKUP_GLOBAL_CAP.window_minutes, Date.now()), RRO_STRIPE_LOOKUP_GLOBAL_CAP.max_hits);
  noStripe();
  let r;
  const logs = await captureLogs(async () => { r = await worker.fetch(get("/api/rro/pack?session_id=" + sid), e); });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { status: "error", error: "UNAVAILABLE" });
  assert.equal(stripeCalls.length, 0);
  const a = alerts(logs).find((x) => x.alert === "stripe_lookup_global_cap_hit");
  assert.ok(a);
  assert.equal(a.max, RRO_STRIPE_LOOKUP_GLOBAL_CAP.max_hits);
  assert.ok(!logs.some((l) => l.includes(sid) || l.includes(IP)));
});

test("P41: webhook failures are alert lines: bad signature, mode mismatch, D1 write failure (500, Stripe retries), missing paid row", async () => {
  const e = configuredEnv();
  noStripe();
  let r;
  let logs = await captureLogs(async () => {
    r = await worker.fetch(new Request("https://parish.technoplusit.co.uk/api/rro/stripe-webhook", { method: "POST", headers: { "Stripe-Signature": "t=1,v1=00", "Content-Type": "application/json" }, body: "{}" }), e);
  });
  assert.equal(r.status, 400);
  assert.ok(alerts(logs).some((x) => x.alert === "webhook_signature_failed"));

  const live = paidSession("cs_test_P41MODEMISMATCH0001", { livemode: true });
  logs = await captureLogs(async () => { r = await worker.fetch(webhookReq({ type: "checkout.session.completed", data: { object: live } }), e); });
  assert.equal(r.status, 400);
  assert.ok(alerts(logs).some((x) => x.alert === "webhook_mode_mismatch"));

  const good = e.RRO_CHECKOUT_DB;
  const failing = { ...good, prepare: (sql) => (/VALUES \('paid'/.test(sql) ? { bind: () => ({ run: async () => { throw new Error("d1 write failed"); } }) } : good.prepare(sql)) };
  const e2 = { ...e, RRO_CHECKOUT_DB: failing };
  logs = await captureLogs(async () => { r = await worker.fetch(webhookReq({ type: "checkout.session.completed", data: { object: paidSession("cs_test_P41RECORDFAIL000001") } }), e2); });
  assert.equal(r.status, 500, "non-2xx so Stripe retries the delivery");
  assert.ok(alerts(logs).some((x) => x.alert === "webhook_record_failed" && /d1 write failed/.test(x.error)));

  // Stripe says paid but no verified webhook ever recorded it.
  const sid = "cs_test_P41MISSINGPAID000001";
  seedStart(e, sid);
  mockStripe(() => jsonResp(paidSession(sid)));
  logs = await captureLogs(async () => { r = await worker.fetch(get("/api/rro/pack?session_id=" + sid), e); });
  assert.equal(r.status, 200);
  const miss = alerts(logs).find((x) => x.alert === "webhook_paid_row_missing");
  assert.ok(miss);
  assert.equal(miss.mode, "test");
  assert.ok(!logs.some((l) => l.includes(sid)));
  // Once recorded, the next lookup does not alert again.
  rroResetIsolateStateForTests();
  logs = await captureLogs(async () => { r = await worker.fetch(get("/api/rro/pack?session_id=" + sid), e); });
  assert.equal(r.status, 200);
  assert.ok(!alerts(logs).some((x) => x.alert === "webhook_paid_row_missing"));
});
