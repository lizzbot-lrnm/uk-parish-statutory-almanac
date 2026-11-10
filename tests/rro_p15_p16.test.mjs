// node --test tests/  — pre-LIVE batch P15 (per-IP search/calculate limit) and P16 (generic public error codes).
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

test("P15/P40: without the pepper the local limiter still applies (no D1 writes); a D1 error fails open per hit; never stores a raw IP", async () => {
  const noPepper = disabledEnv({ RRO_IP_PEPPER: undefined });
  for (let i = 0; i < RRO_PUBLIC_RATE_LIMIT.max_hits; i++) assert.equal((await worker.fetch(get("/api/rro-search?limit=1"), noPepper)).status, 200);
  assert.equal((await worker.fetch(get("/api/rro-search?limit=1"), noPepper)).status, 429, "P40: no fail-open without the pepper");
  assert.deepEqual(noPepper.RRO_CHECKOUT_DB._writes, []);
  rroResetIsolateStateForTests();
  const broken = disabledEnv({ RRO_CHECKOUT_DB: { prepare: () => { throw new Error("d1 down"); }, batch: async () => { throw new Error("d1 down"); } } });
  const logs = await captureLogs(async () => {
    for (let i = 0; i < 20; i++) assert.equal((await worker.fetch(get("/api/rro-search?limit=1"), broken)).status, 200);
  });
  assert.ok(logs.some((l) => l.includes("\"rro_alert\"") && l.includes("public_rate_limit_d1_error")));
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
    // The HTML success page for the same lookup is never cacheable (error and 200 states alike).
    const page = await captureLogs(async () => { r = await worker.fetch(get(path.replace("/api/rro/pack?", "/rro/pack/success?")), e); });
    assert.equal(r.status, status);
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.ok(page.every((l) => !l.includes("P16")));
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
  // Same CORS headers as the other public API errors.
  assert.equal(r2.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(r2.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
  assert.equal(r2.headers.get("Access-Control-Allow-Headers"), "Content-Type, Accept, MCP-Protocol-Version");
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
