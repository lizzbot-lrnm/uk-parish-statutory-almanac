// node --test tests/  — pre-LIVE batch: P2 (not-paid cache + global Stripe cap), P3 (global D1 pack-lookup
// limiter), P15 (per-IP search/calculate limit), P16 (generic public error codes), P39 (client error states,
// hash-based CSP + frame headers, one region rule). No network: Stripe is mocked.
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

const ORIGIN = "https://parish.technoplusit.co.uk";
const FAKE_KEY = "sk_test_" + "FAKEFAKEFAKE0123456789";
const FAKE_WHSEC = "whsec_" + "unit_test_only_not_a_real_secret";
const FAKE_PEPPER = "unit-test-pepper-" + "not-a-real-secret-000";
const IP = "203.0.113.7";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const writes = [];
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql); return db.prepare(sql).get(...args) ?? null; },
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql); return { success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (s) => Promise.all(s.map((x) => x.run())), _db: db, _writes: writes };
}
const configuredEnv = (over = {}) => { rroResetIsolateStateForTests(); return { STRIPE_SECRET_KEY: FAKE_KEY, STRIPE_WEBHOOK_SECRET: FAKE_WHSEC, RRO_IP_PEPPER: FAKE_PEPPER, RRO_CHECKOUT_DB: fakeD1(), ...over }; };
// Production today: pepper + D1, no Stripe secrets.
const disabledEnv = (over = {}) => { rroResetIsolateStateForTests(); return { RRO_IP_PEPPER: FAKE_PEPPER, RRO_CHECKOUT_DB: fakeD1(), ...over }; };
const get = (p, h = {}) => new Request(ORIGIN + p, { headers: { "CF-Connecting-IP": IP, ...h } });
const post = (p, body, h = {}) => new Request(ORIGIN + p, { method: "POST", headers: { "CF-Connecting-IP": IP, "Content-Type": "application/json", ...h }, body: JSON.stringify(body) });

let stripeCalls = [];
function mockStripe(handler) { stripeCalls = []; globalThis.fetch = async (url, init = {}) => { stripeCalls.push(String(url)); return handler(String(url), init); }; }
const noStripe = () => mockStripe(() => { throw new Error("must not call Stripe"); });
const jsonResp = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
function paidSession(id, extra = {}) {
  return { id, object: "checkout.session", payment_status: "paid", livemode: false, amount_total: 2400, currency: "gbp", created: Math.floor(Date.now() / 1000),
    metadata: { product: "tribunal_appeal_pack", region: "London", party_role: "landlord_defence", monthly_rent_gbp: "1800", months_unlicensed: "12", universal_credit_housing_gbp: "0", utilities_included_monthly_gbp: "150", mitigation_factors: "" }, ...extra };
}
function seedStart(e, sid) {
  for (const sql of RRO_CHECKOUT_SCHEMA) e.RRO_CHECKOUT_DB._db.exec(sql);
  e.RRO_CHECKOUT_DB._db.prepare("INSERT INTO rro_checkout_events (kind, stripe_mode, session_id, ip_hash, amount_total, currency, created_at_utc) VALUES ('checkout_start','test',?,'seed',2400,'gbp',?)").run(sid, new Date().toISOString());
}
function sign(payload, t = Math.floor(Date.now() / 1000)) { return "t=" + t + ",v1=" + crypto.createHmac("sha256", FAKE_WHSEC).update(t + "." + payload).digest("hex"); }
const webhookReq = (event) => { const p = JSON.stringify(event); return new Request(ORIGIN + "/api/rro/stripe-webhook", { method: "POST", headers: { "Stripe-Signature": sign(p), "Content-Type": "application/json" }, body: p }); };
const counters = (e) => {
  const db = e.RRO_CHECKOUT_DB._db;
  return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='rro_rate_counters'").get().n ? db.prepare("SELECT bucket, key_hash, window_start_utc, n FROM rro_rate_counters ORDER BY bucket").all() : [];
};
async function withNow(ms, fn) { const real = Date.now; Date.now = () => ms; try { return await fn(); } finally { Date.now = real; } }
async function captureLogs(fn) { const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(" ")); try { await fn(); } finally { console.log = orig; } return logs; }
const PUBLIC_CODES = new Set(["INVALID_REQUEST", "PAYMENT_NOT_COMPLETE", "NOT_FOUND", "NOT_AVAILABLE", "RATE_LIMITED", "UNAVAILABLE"]);

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

// ---------------------------------------------------------------- P15
const P15_PATHS = ["/api/rro-search", "/api/rro/search", "/api/rro/search/", "/api/rro-calculate", "/api/rro/calculate", "/api/rro/calculate/"];
test("P15: per-IP limit on search + calculate (GET and POST, every alias): 429 no-store + Retry-After, other IPs unaffected", async () => {
  const e = disabledEnv();
  const max = RRO_PUBLIC_RATE_LIMIT.max_hits;
  for (let i = 0; i < max; i++) {
    const p = P15_PATHS[i % P15_PATHS.length];
    const r = await worker.fetch(i % 2 ? post(p, { limit: 1 }) : get(p + "?limit=1"), e);
    assert.equal(r.status, 200, p + " #" + i);
  }
  for (const p of P15_PATHS) {
    for (const req of [get(p), post(p, {})]) {
      const r = await worker.fetch(req, e);
      assert.equal(r.status, 429, req.method + " " + p);
      assert.equal(r.headers.get("Cache-Control"), "no-store");
      const ra = Number(r.headers.get("Retry-After"));
      assert.ok(Number.isInteger(ra) && ra >= 1 && ra <= RRO_PUBLIC_RATE_LIMIT.window_minutes * 60);
      assert.deepEqual(await r.json(), { status: "error", error: "RATE_LIMITED" });
    }
  }
  assert.equal((await worker.fetch(get("/api/rro-search?limit=1", { "CF-Connecting-IP": "198.51.100.20" }), e)).status, 200);
  // Unrelated routes are not limited.
  assert.equal((await worker.fetch(get("/rro"), e)).status, 200);
});

test("P15: D1 cost — a normal visitor writes nothing; a heavy one writes 1 upsert per 10 admitted requests into ONE row; floods write nothing", async () => {
  const e = disabledEnv();
  const w = e.RRO_CHECKOUT_DB._writes;
  for (let i = 0; i < RRO_PUBLIC_RATE_LIMIT.flush_every - 1; i++) await worker.fetch(get("/api/rro-search?limit=1"), e);
  assert.equal(w.length, 0, "fewer than flush_every requests -> zero D1 writes");
  for (let i = RRO_PUBLIC_RATE_LIMIT.flush_every - 1; i < RRO_PUBLIC_RATE_LIMIT.max_hits; i++) await worker.fetch(get("/api/rro-calculate"), e);
  const upserts = w.filter((s) => s.includes("rro_rate_counters"));
  assert.equal(upserts.length, RRO_PUBLIC_RATE_LIMIT.max_hits / RRO_PUBLIC_RATE_LIMIT.flush_every);
  const before = w.length;
  for (let i = 0; i < 200; i++) assert.equal((await worker.fetch(get("/api/rro-search"), e)).status, 429);
  assert.equal(w.length, before, "over-limit requests write nothing");
  const rows = counters(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bucket, "public_api");
  assert.equal(rows[0].n, RRO_PUBLIC_RATE_LIMIT.max_hits);
  assert.match(rows[0].key_hash, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(rows).includes(IP), "no raw IP stored");
  assert.ok(!w.some((s) => s.includes("rro_rate_hits")), "no per-request rows in rro_rate_hits");
});

test("P15: the D1 total is global — spreading requests over isolates/colos is still stopped (within one flush batch per colo)", async () => {
  const e = disabledEnv();
  let admitted = 0;
  for (let i = 0; i < 60; i++) if ((await worker.fetch(get("/api/rro-search?limit=1"), e)).status === 200) admitted++;
  rroResetIsolateStateForTests(); // second colo
  let limited = false;
  for (let i = 0; i < 200 && !limited; i++) {
    const r = await worker.fetch(get("/api/rro-search?limit=1"), e);
    if (r.status === 200) admitted++; else limited = r.status === 429;
  }
  assert.ok(limited, "second colo is stopped by the global count");
  assert.ok(admitted < RRO_PUBLIC_RATE_LIMIT.max_hits + 2 * RRO_PUBLIC_RATE_LIMIT.flush_every, "admitted " + admitted);
});

test("P15: fails open without the pepper or when D1 errors (free public tools stay up); never stores a raw IP", async () => {
  const noPepper = disabledEnv({ RRO_IP_PEPPER: undefined });
  for (let i = 0; i < RRO_PUBLIC_RATE_LIMIT.max_hits + 5; i++) assert.equal((await worker.fetch(get("/api/rro-search?limit=1"), noPepper)).status, 200);
  assert.deepEqual(noPepper.RRO_CHECKOUT_DB._writes, []);
  const broken = disabledEnv({ RRO_CHECKOUT_DB: { prepare: () => { throw new Error("d1 down"); }, batch: async () => { throw new Error("d1 down"); } } });
  const logs = await captureLogs(async () => {
    for (let i = 0; i < 20; i++) assert.equal((await worker.fetch(get("/api/rro-search?limit=1"), broken)).status, 200);
  });
  assert.ok(logs.some((l) => l.includes("rro_public_rate_limit_d1_error")));
  // The colo limit still applies when D1 is down.
  await captureLogs(async () => {
    for (let i = 20; i < RRO_PUBLIC_RATE_LIMIT.max_hits; i++) assert.equal((await worker.fetch(get("/api/rro-search?limit=1"), broken)).status, 200);
    assert.equal((await worker.fetch(get("/api/rro-search"), broken)).status, 429);
  });
});

test("P15: the hourly cron prunes counter rows older than 1 h and keeps current ones", async () => {
  const e = disabledEnv();
  for (let i = 0; i < RRO_PUBLIC_RATE_LIMIT.flush_every; i++) await worker.fetch(get("/api/rro-search?limit=1"), e);
  const db = e.RRO_CHECKOUT_DB._db;
  db.prepare("INSERT INTO rro_rate_counters (bucket, key_hash, window_start_utc, n) VALUES ('public_api','old',?,5)").run(new Date(Date.now() - 2 * 3600000).toISOString());
  assert.equal(counters(e).length, 2);
  await worker.scheduled({}, e);
  const rows = counters(e);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].key_hash, "old");
});

test("P15: the counter prune uses ix_rro_rate_counters_window (no full table scan); migration 0003 matches the lazy schema", async () => {
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  for (const sql of RRO_CHECKOUT_SCHEMA) db.exec(sql);
  const plan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM rro_rate_counters WHERE window_start_utc < ?").all("2026-01-01T00:00:00.000Z").map((r) => r.detail).join(" | ");
  assert.match(plan, /ix_rro_rate_counters_window/);
  const mig = new DatabaseSync(":memory:");
  mig.exec(readFileSync(new URL("../migrations/0003_rro_rate_counters.sql", import.meta.url), "utf8"));
  const cols = (d) => d.prepare("PRAGMA table_info(rro_rate_counters)").all().map((c) => [c.name, c.type, c.notnull, c.pk]);
  assert.deepEqual(cols(mig), cols(db));
});

// ---------------------------------------------------------------- P16
test("P16: /api/rro/pack only returns generic public codes; internal codes go to the log without the session id", async () => {
  const sid = "cs_test_P16EXPIRED000000001";
  const cases = [];
  // Disabled (keys unset): 503 UNAVAILABLE, not CHECKOUT_NOT_CONFIGURED.
  cases.push([disabledEnv(), "/api/rro/pack?session_id=" + sid, 503, "UNAVAILABLE", "CHECKOUT_NOT_CONFIGURED"]);
  // Mode mismatch: 404 NOT_FOUND, not SESSION_MODE_MISMATCH.
  cases.push([configuredEnv(), "/api/rro/pack?session_id=cs_live_P16MODE0000000001", 404, "NOT_FOUND", "SESSION_MODE_MISMATCH"]);
  // Expired download: 410 NOT_AVAILABLE, not DOWNLOAD_EXPIRED.
  const ex = configuredEnv();
  seedStart(ex, sid);
  cases.push([ex, "/api/rro/pack?session_id=" + sid, 410, "NOT_AVAILABLE", "DOWNLOAD_EXPIRED"]);
  mockStripe(() => jsonResp(paidSession(sid, { created: Math.floor(Date.now() / 1000) - 40 * 86400 })));
  for (const [e, path, status, code, internal] of cases) {
    let r;
    const logs = await captureLogs(async () => { r = await worker.fetch(get(path), e); });
    assert.equal(r.status, status, path);
    const body = await r.json();
    assert.deepEqual(body, { status: "error", error: code });
    assert.ok(PUBLIC_CODES.has(body.error));
    assert.ok(logs.some((l) => l.includes(internal)), "internal code logged: " + internal);
    assert.ok(logs.every((l) => !l.includes("P16")), "no session id in logs");
  }
});

test("P16: an upstream (Stripe) error message never reaches the client; unexpected exceptions are a generic 500", async () => {
  const e = configuredEnv();
  const sid = "cs_test_P16UPSTREAM00000001";
  seedStart(e, sid);
  mockStripe(() => jsonResp({ error: { message: "Invalid API Key provided: sk_test_****1234", type: "invalid_request_error" } }, 401));
  const r = await worker.fetch(get("/api/rro/pack?session_id=" + sid), e);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { status: "error", error: "UNAVAILABLE" });
  assert.doesNotMatch(text, /Invalid API Key|sk_test|invalid_request_error|stripe/i);
  const boom = configuredEnv({ RRO_CHECKOUT_DB: { prepare: () => { throw new Error("SECRET internal stack detail"); }, batch: async () => { throw new Error("SECRET internal stack detail"); } } });
  let r2;
  const logs = await captureLogs(async () => { r2 = await worker.fetch(get("/api/rro/pack?session_id=" + sid), boom); });
  assert.equal(r2.status, 500);
  const t2 = await r2.text();
  assert.deepEqual(JSON.parse(t2), { status: "error", error: "INTERNAL_ERROR" });
  assert.doesNotMatch(t2, /SECRET|stack|at /);
  assert.equal(r2.headers.get("Cache-Control"), "no-store");
  assert.ok(logs.some((l) => l.includes("unhandled_error") && l.includes("SECRET internal stack detail")));
});

test("P16: the disabled-state contract is unchanged (checkout/webhook codes, X-RRO-CTA hidden, £29 paths 404)", async () => {
  noStripe();
  const e = disabledEnv();
  const c = await worker.fetch(new Request(ORIGIN + "/api/rro/checkout", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": IP }, body: "{}" }), e);
  assert.equal(c.status, 503);
  assert.deepEqual(await c.json(), { status: "error", error: "CHECKOUT_NOT_CONFIGURED" });
  const w = await worker.fetch(new Request(ORIGIN + "/api/rro/stripe-webhook", { method: "POST", headers: { "Stripe-Signature": "t=1,v1=00" }, body: "{}" }), e);
  assert.equal(w.status, 503);
  const page = await worker.fetch(get("/rro"), e);
  assert.equal(page.headers.get("X-RRO-CTA"), "hidden");
  const html = await page.text();
  assert.ok(!html.includes('id="formalPackBtn"'));
  assert.match(html, /Application Pack \(£24\)/);
  for (const p of ["/api/rro-buy-pack", "/api/rro/buy-pack"]) assert.equal((await worker.fetch(get(p), e)).status, 404);
  assert.deepEqual(stripeCalls, []);
});

// ---------------------------------------------------------------- P39 headers
const sha256b64 = (s) => "'sha256-" + crypto.createHash("sha256").update(s, "utf8").digest("base64") + "'";
for (const path of ["/rro", "/", "/rro/london"]) {
  test("P39: " + path + " has a hash-based CSP (no 'unsafe-inline' scripts) that allows exactly its inline script, plus frame headers", async () => {
    const r = await worker.fetch(get(path), disabledEnv());
    assert.equal(r.status, 200);
    const csp = r.headers.get("Content-Security-Policy");
    const html = await r.text();
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src "));
    assert.ok(scriptSrc, csp);
    assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval|\*/);
    const inline = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter((m) => !/type=/.test(m[1] || "")).map((m) => m[2]);
    for (const s of inline) assert.ok(scriptSrc.includes(sha256b64(s)), "hash for inline script present");
    assert.equal((scriptSrc.match(/'sha256-/g) || []).length, inline.length);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /script-src-attr 'none'/);
    assert.equal(r.headers.get("X-Frame-Options"), "DENY");
    assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  });
}
test("P39: script hashes come from the trusted template, not the response — the /rro CSP is identical in every CTA state and an extra body script is not allow-listed", async () => {
  const { rroHtmlCsp } = await import("../src/rro_core.js");
  const a = (await worker.fetch(get("/rro"), disabledEnv())).headers.get("Content-Security-Policy");
  const b = (await worker.fetch(get("/rro"), configuredEnv({ STRIPE_SECRET_KEY: "sk_live_" + "FAKE0123456789", RRO_STRIPE_LIVE_ENABLED: "true" }))).headers.get("Content-Security-Policy");
  assert.equal(a, b);
  const tmpl = "<p>x</p><script>trusted()</script>";
  const csp = await rroHtmlCsp(tmpl);
  assert.ok(csp.includes(sha256b64("trusted()")));
  assert.ok(!csp.includes(sha256b64("evil()")));
  assert.equal(((await rroHtmlCsp("")).match(/'sha256-/g) || []).length, 0);
});

test("P39: /rro has no inline event-handler attributes (they would be blocked by the CSP)", async () => {
  const html = await (await worker.fetch(get("/rro"), disabledEnv())).text();
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ""), /\son[a-z]+\s*=/i);
});

// ---------------------------------------------------------------- P39 client error states
async function loadRroScript(fetchImpl) {
  const html = await (await worker.fetch(get("/rro"), disabledEnv())).text();
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0];
  const els = new Map(); const listeners = new Map();
  const mk = (id) => ({ id, value: "", textContent: "", innerHTML: "", href: "", className: "", colSpan: 0, children: [], attrs: {},
    addEventListener(type, fn) { listeners.set(id + ":" + type, fn); }, appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; } });
  const el = (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); };
  const rejections = [];
  const onRej = (r) => rejections.push(r);
  process.on("unhandledRejection", onRej);
  const ctx = { document: { getElementById: el, createElement: (t) => mk(t) }, window: { location: { search: "" } },
    URL, URLSearchParams, JSON, Number, String, Array, Math, console, setTimeout, fetch: fetchImpl };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await new Promise((r) => setTimeout(r, 30));
  return { el, listeners, rejections, done: () => process.off("unhandledRejection", onRej) };
}
const allText = (node) => (node.textContent || "") + (node.children || []).map(allText).join("");

test("P39: network failure -> friendly search error, no unhandled rejection", async () => {
  const h = await loadRroScript(() => Promise.reject(new TypeError("Failed to fetch")));
  try {
    assert.match(allText(h.el("resultsBody")), /could not reach the server/);
    assert.equal(h.el("statCount").textContent, "—");
    await h.listeners.get("calcBtn:click")();
    assert.match(h.el("calcOutput").textContent, /could not reach the server/);
    await h.listeners.get("auditBtn:click")();
    assert.match(h.el("auditOutput").textContent, /could not reach the server/);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(h.rejections, []);
  } finally { h.done(); }
});

test("P39: an HTML 5xx page or a 429 -> friendly error states, no unhandled rejection", async () => {
  const html500 = () => Promise.resolve({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  const h = await loadRroScript(html500);
  try {
    assert.match(allText(h.el("resultsBody")), /temporarily unavailable/);
    await h.listeners.get("calcBtn:click")();
    assert.match(h.el("calcOutput").textContent, /temporarily unavailable/);
    assert.doesNotMatch(h.el("calcOutput").textContent, /Unexpected token/);
  } finally { h.done(); }
  const h2 = await loadRroScript(() => Promise.resolve({ ok: false, status: 429, json: async () => ({ status: "error", error: "RATE_LIMITED" }) }));
  try {
    assert.match(allText(h2.el("resultsBody")), /Too many requests/);
    await h2.listeners.get("calcBtn:click")();
    assert.match(h2.el("calcOutput").textContent, /Too many requests/);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...h.rejections, ...h2.rejections], []);
  } finally { h2.done(); }
});

test("P39: success path still renders (search stats + calculator output)", async () => {
  const ok = (u) => Promise.resolve({ ok: true, status: 200, json: async () => (String(u).startsWith("/api/rro-search")
    ? { stats: { total_matched: 2, median_award_pct: 60, mean_award_pct: 60.3, total_claimed_gbp: 1, total_awarded_gbp: 1 }, results: [] }
    : { calculation: { a: 1 }, schedule_markdown: "| x |" }) });
  const h = await loadRroScript(ok);
  try {
    assert.equal(h.el("statCount").textContent, 2);
    await h.listeners.get("calcBtn:click")();
    assert.match(h.el("calcOutput").textContent, /^\{/);
  } finally { h.done(); }
});

// ---------------------------------------------------------------- P39 region rule
test("P39: one region rule — unknown region is 'all' in both the pack path and the calculator; known regions any case", async () => {
  assert.equal(rroCleanInputs({ region: "WORFMARK" }).region, "all");
  assert.equal(rroCleanInputs({ region: "london" }).region, "London");
  assert.equal(rroCleanInputs({ region: " Northern " }).region, "Northern");
  assert.equal(rroCleanInputs({}).region, "London");
  assert.equal(rroCleanInputs({ region: "  " }).region, "London", "blank is London, as in the calculator");
  const blank = await (await worker.fetch(post("/api/rro-calculate", { region: "" }), disabledEnv())).json();
  const london = await (await worker.fetch(post("/api/rro-calculate", { region: "London" }), disabledEnv())).json();
  assert.deepEqual(blank.calculation, london.calculation);
  const calc = await (await worker.fetch(get("/api/rro-calculate?region=WORFMARK"), disabledEnv())).json();
  assert.equal(JSON.stringify(calc).includes("WORFMARK"), false);
});
