// node --test tests/  — P76: per-ip_hash (per-/64) daily limit on new checkout starts: D1-counted, fail
// closed, never calls Stripe once over, counted before the global cap, paid buyers unaffected. No network.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker from "../worker.js";
import { RRO_CHECKOUT_IP_DAILY_LIMIT, RRO_CHECKOUT_SCHEMA, RRO_ALERT_EVENT, rroResetIsolateStateForTests } from "../src/rro_core.js";
import { ORIGIN, configuredEnv, get, stripeCalls, mockStripe, jsonResp, paidSession, seedStart, counters, withNow, captureLogs } from "./rro_batch_helpers.mjs";

const PREVIEW_SECRET = "unit-test-preview-" + "secret-not-real-000000";
const previewCookie = () => { const exp = Math.floor(Date.now() / 1000) + 3600; return "rro_preview=" + exp + "." + crypto.createHmac("sha256", PREVIEW_SECRET).update("rro-preview-cookie-v1:" + exp).digest("hex"); };
const env = (over = {}) => configuredEnv({ RRO_PREVIEW_SECRET: PREVIEW_SECRET, ...over });
const checkout = (ip) => new Request(ORIGIN + "/api/rro/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": ip, Cookie: previewCookie() },
  body: JSON.stringify({ region: "London" }),
});
let sidN = 0;
const stripeOk = () => mockStripe(() => { const id = "cs_test_P76SESSION" + String(++sidN).padStart(10, "0"); return jsonResp({ id, url: "https://checkout.stripe.com/c/pay/" + id }); });
const alerts = (logs) => logs.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((j) => j && j.event === RRO_ALERT_EVENT);
const rows = (e, b) => counters(e).filter((c) => c.bucket === b);
const DAY = Date.UTC(2027, 2, 9);
// 5 starts per 10-minute window is the existing per-IP limit, so spread starts over windows of one UTC day.
const at = (i) => DAY + 3600000 + Math.floor(i / 5) * 11 * 60000 + (i % 5) * 1000;

test("P76: the limit is a named constant of 20 per ip_hash per UTC day", () => {
  assert.equal(RRO_CHECKOUT_IP_DAILY_LIMIT, 20);
});

test("P76: the 21st start from one /64 in a UTC day is refused (429), Stripe never called, global budget untouched", async () => {
  rroResetIsolateStateForTests();
  const e = env();
  stripeOk();
  const codes = [];
  // Two addresses in the same IPv6 /64 share one ip_hash.
  for (let i = 0; i < 20; i++) codes.push(await withNow(at(i), async () => (await worker.fetch(checkout(i % 2 ? "2001:db8:1:2::a" : "2001:db8:1:2::b"), e)).status));
  assert.deepEqual(codes, Array(20).fill(200));
  assert.equal(stripeCalls.length, 20);
  let r;
  const logs = await captureLogs(() => withNow(at(20), async () => { r = await worker.fetch(checkout("2001:db8:1:2::c"), e); }));
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { status: "error", error: "RATE_LIMITED" });
  assert.ok(Number(r.headers.get("Retry-After")) > 0);
  assert.equal(stripeCalls.length, 20, "no Stripe call once over");
  assert.ok(alerts(logs).some((x) => x.alert === "checkout_ip_daily_limit_hit" && x.limit === 20));
  assert.equal(rows(e, "checkout_ip_daily").length, 1, "one row keyed by the /64's ip_hash");
  assert.equal(rows(e, "checkout_ip_daily")[0].n, 20);
  assert.ok(!/2001:db8/.test(rows(e, "checkout_ip_daily")[0].key_hash), "key is the peppered hash, not the address");
  assert.equal(rows(e, "checkout_daily")[0].n, 20, "the refused start never reached the global counter");
  // Another /64 is unaffected the same day; the same /64 is admitted again the next UTC day.
  assert.equal(await withNow(at(21), async () => (await worker.fetch(checkout("2001:db8:9:9::1"), e)).status), 200);
  assert.equal(await withNow(DAY + 86400000 + 3600000, async () => (await worker.fetch(checkout("2001:db8:1:2::a"), e)).status), 200);
});

test("P76: a per-IP daily counter error fails closed (503, no Stripe call)", async () => {
  rroResetIsolateStateForTests();
  const e = env();
  const db = e.RRO_CHECKOUT_DB;
  for (const s of RRO_CHECKOUT_SCHEMA) db._db.exec(s);
  e.RRO_CHECKOUT_DB = { ...db, prepare: (sql) => {
    const st = db.prepare(sql);
    if (!(/rro_rate_counters/.test(sql) && /^\s*INSERT/i.test(sql))) return st;
    return { bind: (...a) => (a[0] === "checkout_ip_daily" ? { first: async () => { throw new Error("D1_ERROR: write failed"); } } : st.bind(...a)) };
  } };
  stripeOk();
  const before = stripeCalls.length;
  let r;
  const logs = await captureLogs(async () => { r = await worker.fetch(checkout("198.51.100.77"), e); });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { status: "error", error: "CHECKOUT_UNAVAILABLE" });
  assert.equal(stripeCalls.length, before);
  assert.ok(alerts(logs).some((x) => x.alert === "checkout_ip_daily_counter_failed"));
});

test("P76: paid buyers are unaffected; the per-IP daily row survives the hourly purge and goes after 48 h", async () => {
  rroResetIsolateStateForTests();
  const e = env();
  stripeOk();
  for (let i = 0; i < 20; i++) await withNow(at(i), () => worker.fetch(checkout("203.0.113.50"), e));
  assert.equal(await withNow(at(20), async () => (await worker.fetch(checkout("203.0.113.50"), e)).status), 429);
  const sid = "cs_test_P76PAIDBUYER00000001";
  seedStart(e, sid);
  mockStripe(() => jsonResp(paidSession(sid)));
  const pack = await withNow(at(21), () => worker.fetch(get("/api/rro/pack?session_id=" + sid, { "CF-Connecting-IP": "203.0.113.50" }), e));
  assert.equal(pack.status, 200, "the pack still loads for the capped IP");
  await withNow(DAY + 20 * 3600000, () => worker.scheduled({}, e));
  assert.equal(rows(e, "checkout_ip_daily").length, 1, "kept through the day");
  await withNow(DAY + 73 * 3600000, () => worker.scheduled({}, e));
  assert.equal(rows(e, "checkout_ip_daily").length, 0, "dropped after 48 h");
});
