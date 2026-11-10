// node --test tests/  — pre-LIVE batch P2 (not-paid cache + global Stripe cap) and P3 (global D1 pack-lookup limiter, IPv6 /64).
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker.js";
import {
  rroResetIsolateStateForTests,
  rroCleanInputs,
  rroWindowStartIso,
  RRO_PUBLIC_RATE_LIMIT,
  RRO_LOOKUP_RATE_LIMIT,
  RRO_STRIPE_LOOKUP_GLOBAL_CAP,
  RRO_NOT_PAID_CACHE_TTL_MS,
  RRO_CHECKOUT_SCHEMA,
} from "../src/rro_core.js";
import {
  ORIGIN,
  FAKE_KEY,
  FAKE_WHSEC,
  FAKE_PEPPER,
  IP,
  fakeD1,
  configuredEnv,
  disabledEnv,
  get,
  post,
  stripeCalls,
  mockStripe,
  noStripe,
  jsonResp,
  paidSession,
  seedStart,
  sign,
  webhookReq,
  counters,
  withNow,
  captureLogs,
  PUBLIC_CODES,
} from "./rro_batch_helpers.mjs";

// ---------------------------------------------------------------- P2
test("P2: an unpaid verdict is cached for 30 s per session (one Stripe call), then re-checked", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P2UNPAID00000000001";
  seedStart(e, sid);
  mockStripe(() => jsonResp(paidSession(sid, { payment_status: "unpaid" })));
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    const r = await withNow(t0 + i * 1000, () => worker.fetch(get("/api/rro/pack?session_id=" + sid), e));
    assert.equal(r.status, 402);
    assert.deepEqual(await r.json(), { status: "error", error: "PAYMENT_NOT_COMPLETE" });
  }
  assert.equal(stripeCalls.length, 1, "repeat unpaid lookups inside 30 s do not hit Stripe");
  assert.ok(RRO_NOT_PAID_CACHE_TTL_MS >= 30000 && RRO_NOT_PAID_CACHE_TTL_MS <= 60000);
  await withNow(t0 + RRO_NOT_PAID_CACHE_TTL_MS + 1000, () => worker.fetch(get("/rro/pack/success?session_id=" + sid), e));
  assert.equal(stripeCalls.length, 2, "after the TTL the session is checked again");
});

test("P2: a Stripe 404 is cached too; a webhook 'paid' row bypasses the not-paid cache", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P2BYPASS00000000001";
  seedStart(e, sid);
  mockStripe(() => jsonResp({ error: { message: "No such checkout.session: internal detail" } }, 404));
  for (let i = 0; i < 3; i++) {
    const r = await worker.fetch(get("/api/rro/pack?session_id=" + sid), e);
    assert.equal(r.status, 404);
    const text = await r.text();
    assert.doesNotMatch(text, /internal detail|No such|checkout\.session/);
  }
  assert.equal(stripeCalls.length, 1);
  mockStripe(() => jsonResp(paidSession(sid)));
  assert.equal((await worker.fetch(webhookReq({ type: "checkout.session.completed", data: { object: paidSession(sid) } }), e)).status, 200);
  assert.equal((await worker.fetch(get("/api/rro/pack?session_id=" + sid), e)).status, 200, "paid buyer is not held back by the not-paid cache");
  const ok = await worker.fetch(get("/rro/pack/success?session_id=" + sid), e);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store", "the paid success page is never cacheable");
});

test("P2: global cap on Stripe lookups (all IPs) is a D1 counter; at the cap -> 503 generic, no Stripe call", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P2GLOBALCAP00000001";
  seedStart(e, sid);
  e.RRO_CHECKOUT_DB._db.prepare("INSERT INTO rro_rate_counters (bucket, key_hash, window_start_utc, n) VALUES ('stripe_lookup','global',?,?)")
    .run(rroWindowStartIso(RRO_STRIPE_LOOKUP_GLOBAL_CAP.window_minutes, Date.now()), RRO_STRIPE_LOOKUP_GLOBAL_CAP.max_hits);
  noStripe();
  let r;
  const logs = await captureLogs(async () => { r = await worker.fetch(get("/api/rro/pack?session_id=" + sid, { "CF-Connecting-IP": "198.51.100.9" }), e); });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { status: "error", error: "UNAVAILABLE" });
  assert.equal(stripeCalls.length, 0);
  assert.ok(logs.some((l) => l.includes("STRIPE_LOOKUP_GLOBAL_CAP")));
  const row = counters(e).find((c) => c.bucket === "stripe_lookup");
  assert.equal(row.n, RRO_STRIPE_LOOKUP_GLOBAL_CAP.max_hits, "over the cap nothing is written");
});

test("P2: webhook-confirmed paid sessions are not subject to the global cap, so unpaid polling cannot lock out real buyers", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P2PAIDBYPASS0000001";
  mockStripe(() => jsonResp(paidSession(sid)));
  assert.equal((await worker.fetch(webhookReq({ type: "checkout.session.completed", data: { object: paidSession(sid) } }), e)).status, 200);
  seedStart(e, sid);
  e.RRO_CHECKOUT_DB._db.prepare("INSERT INTO rro_rate_counters (bucket, key_hash, window_start_utc, n) VALUES ('stripe_lookup','global',?,?)")
    .run(rroWindowStartIso(RRO_STRIPE_LOOKUP_GLOBAL_CAP.window_minutes, Date.now()), RRO_STRIPE_LOOKUP_GLOBAL_CAP.max_hits);
  const r = await worker.fetch(get("/api/rro/pack?session_id=" + sid), e);
  assert.equal(r.status, 200, "paid buyer still gets the pack with the cap exhausted");
});

test("P2: below the cap each real Stripe lookup counts once on the global counter; unknown sessions never count", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P2COUNT0000000000001";
  seedStart(e, sid);
  mockStripe(() => jsonResp(paidSession(sid, { payment_status: "unpaid" })));
  await worker.fetch(get("/api/rro/pack?session_id=" + sid), e);
  await worker.fetch(get("/api/rro/pack?session_id=" + sid), e); // not-paid cache: no second lookup
  await worker.fetch(get("/api/rro/pack?session_id=cs_test_P2UNKNOWN000000001"), e); // unknown: 404 from D1 first
  assert.equal(counters(e).find((c) => c.bucket === "stripe_lookup").n, 1);
  assert.equal(stripeCalls.length, 1);
});

test("P2: the session-id format stays bounded and validated before anything else", async () => {
  noStripe();
  const e = configuredEnv();
  for (const sid of ["cs_test_short", "cs_test_" + "a".repeat(241), "cs_test_abc$%^&*()_+1234", "x".repeat(5000)]) {
    const r = await worker.fetch(get("/api/rro/pack?session_id=" + encodeURIComponent(sid)), e);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { status: "error", error: "INVALID_REQUEST" });
  }
  assert.deepEqual(counters(e), []);
});

// ---------------------------------------------------------------- P3
test("P3: the pack-lookup limit is global (D1), so a second colo/isolate cannot reset it; over the limit writes nothing", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P3KNOWN00000000001";
  seedStart(e, sid);
  mockStripe(() => jsonResp(paidSession(sid, { payment_status: "unpaid" })));
  for (let i = 0; i < RRO_LOOKUP_RATE_LIMIT.max_hits; i++) {
    assert.equal((await worker.fetch(get(i % 2 ? "/api/rro/pack?session_id=" + sid : "/rro/pack/success?session_id=" + sid), e)).status, 402);
  }
  assert.equal(stripeCalls.length, 1, "not-paid cache: one Stripe call for 30 lookups");
  rroResetIsolateStateForTests(); // another isolate / colo: empty Map, empty not-paid cache, no shared caches.default
  const r = await worker.fetch(get("/rro/pack/success?session_id=" + sid), e);
  assert.equal(r.status, 429);
  assert.match(r.headers.get("Retry-After"), /^\d+$/);
  assert.ok(Number(r.headers.get("Retry-After")) <= RRO_LOOKUP_RATE_LIMIT.window_minutes * 60);
  const rows = counters(e).filter((c) => c.bucket === "pack_lookup");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, RRO_LOOKUP_RATE_LIMIT.max_hits);
  assert.match(rows[0].key_hash, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(rows).includes(IP), "raw IP never stored");
  const other = await worker.fetch(get("/api/rro/pack?session_id=" + sid, { "CF-Connecting-IP": "198.51.100.77" }), e);
  assert.equal(other.status, 402, "another IP is unaffected");
});

test("P3: unknown session ids (random-id floods) cost D1 reads only — no D1 write — and stop at the colo pre-filter", async () => {
  noStripe();
  const e = configuredEnv();
  for (let i = 0; i < RRO_LOOKUP_RATE_LIMIT.max_hits; i++) {
    assert.equal((await worker.fetch(get("/api/rro/pack?session_id=cs_test_P3RANDOM" + String(i).padStart(12, "0")), e)).status, 404);
  }
  assert.equal((await worker.fetch(get("/api/rro/pack?session_id=cs_test_P3RANDOMOVER00001"), e)).status, 429);
  assert.deepEqual(e.RRO_CHECKOUT_DB._writes, []);
  assert.deepEqual(counters(e), []);
});

test("P3/P15: IPv6 clients are bucketed by /64, so rotating addresses inside one /64 shares one limit", async () => {
  const { rroIpBucket } = await import("../src/rro_core.js");
  assert.equal(rroIpBucket("2001:db8:abcd:12:1:2:3:4"), "2001:db8:abcd:12::/64");
  assert.equal(rroIpBucket("2001:0db8:abcd:0012:ffff::1"), "2001:db8:abcd:12::/64");
  assert.equal(rroIpBucket("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(rroIpBucket("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(rroIpBucket("203.0.113.7"), "203.0.113.7");
  const e = disabledEnv();
  for (let i = 0; i < RRO_PUBLIC_RATE_LIMIT.max_hits; i++) {
    const r = await worker.fetch(get("/api/rro-search?limit=1", { "CF-Connecting-IP": "2001:db8:abcd:12::" + (i + 1).toString(16) }), e);
    assert.equal(r.status, 200);
  }
  assert.equal((await worker.fetch(get("/api/rro-search", { "CF-Connecting-IP": "2001:db8:abcd:12:ffff:ffff:ffff:ffff" }), e)).status, 429);
  assert.equal((await worker.fetch(get("/api/rro-search?limit=1", { "CF-Connecting-IP": "2001:db8:abcd:13::1" }), e)).status, 200, "a different /64 is separate");
});

test("P3: disabled state (no Stripe keys) touches no counter: pack lookups 503 before any limiter or D1 write", async () => {
  noStripe();
  const e = disabledEnv();
  for (const p of ["/api/rro/pack?session_id=cs_test_a1B2c3D4e5F6g7H8i9J0", "/rro/pack/success?session_id=cs_test_a1B2c3D4e5F6g7H8i9J0"]) {
    assert.equal((await worker.fetch(get(p), e)).status, 503);
  }
  assert.deepEqual(e.RRO_CHECKOUT_DB._writes, []);
});
