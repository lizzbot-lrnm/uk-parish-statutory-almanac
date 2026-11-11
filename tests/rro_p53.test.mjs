// node --test tests/  — P53/P68/P69: global daily ceiling on new Stripe Checkout sessions (fail closed, no Stripe call
// over the cap or on a counter error), volume alerts, purge retention, paid buyers unaffected. No network.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../worker.js";
import { rroCheckoutDailyCap, rroWindowStartIso, rroResetIsolateStateForTests, RRO_CHECKOUT_DAILY_ALERT_STARTS, RRO_CHECKOUT_DAILY_CAP_DEFAULT, RRO_CHECKOUT_DAILY_WINDOW_MINUTES, RRO_ALERT_EVENT, RRO_CHECKOUT_SCHEMA } from "../src/rro_core.js";
import { ORIGIN, configuredEnv, get, stripeCalls, mockStripe, noStripe, jsonResp, paidSession, seedStart, counters, withNow, captureLogs } from "./rro_batch_helpers.mjs";

const PREVIEW_SECRET = "unit-test-preview-" + "secret-not-real-000000";
const previewCookie = () => { const exp = Math.floor(Date.now() / 1000) + 3600; return "rro_preview=" + exp + "." + crypto.createHmac("sha256", PREVIEW_SECRET).update("rro-preview-cookie-v1:" + exp).digest("hex"); };
const env = (over = {}) => configuredEnv({ RRO_PREVIEW_SECRET: PREVIEW_SECRET, ...over });
let ipN = 0;
const checkout = (ip = "198.51.100." + (++ipN % 250 + 1)) => new Request(ORIGIN + "/api/rro/checkout", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": ip, Cookie: previewCookie() },
  body: JSON.stringify({ region: "London" }),
});
let sidN = 0;
const stripeOk = () => mockStripe(() => { const id = "cs_test_P53SESSION" + String(++sidN).padStart(10, "0"); return jsonResp({ id, url: "https://checkout.stripe.com/c/pay/" + id }); });
const alerts = (logs) => logs.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((j) => j && j.event === RRO_ALERT_EVENT);
const daily = (e) => counters(e).find((c) => c.bucket === "checkout_daily");
// A D1 wrapper whose counter upsert throws for one bucket only (other statements hit the real fake D1).
const failBucket = (db, bucket) => ({ ...db, prepare: (sql) => {
  const st = db.prepare(sql);
  if (!(/rro_rate_counters/.test(sql) && /^\s*INSERT/i.test(sql))) return st;
  return { bind: (...a) => (a[0] === bucket ? { first: async () => { throw new Error("D1_ERROR: write failed"); } } : st.bind(...a)) };
} });

test("P68: the cap is a named default (500), overridable by a plain var, and never 'unlimited' on bad input", () => {
  assert.equal(RRO_CHECKOUT_DAILY_CAP_DEFAULT, 500);
  assert.equal(RRO_CHECKOUT_DAILY_ALERT_STARTS, 20);
  assert.equal(rroCheckoutDailyCap({}), 500);
  assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: "200" }), 200);
  assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: " 75 " }), 75);
  assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: 7 }), 7);
  for (const bad of ["0", "-1", "abc", "1e3", "99999", "Infinity", "12.5", true]) assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: bad }), 500, String(bad));
  const doc = readFileSync(new URL("../deploy/RRO_STRIPE_CHECKOUT.md", import.meta.url), "utf8");
  assert.match(doc, /`RRO_CHECKOUT_DAILY_CAP`/);
  assert.match(doc, /The default is \*\*500\*\* new checkout sessions per UTC day/);
  assert.match(doc, /\*\*20\*\* checkout starts/);
});

test("P69: an invalid RRO_CHECKOUT_DAILY_CAP logs ONE alert per isolate and still uses the default; unset stays silent", async () => {
  rroResetIsolateStateForTests();
  let logs = await captureLogs(async () => {
    assert.equal(rroCheckoutDailyCap({}), 500);
    assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: "" }), 500);
    assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: null }), 500);
  });
  assert.equal(alerts(logs).length, 0, "unset is not invalid");
  logs = await captureLogs(async () => {
    for (let i = 0; i < 5; i++) assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: "lots-SECRETISH" }), 500);
    assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: "0" }), 500);
  });
  const inv = alerts(logs).filter((x) => x.alert === "checkout_daily_cap_invalid");
  assert.equal(inv.length, 1, "one-time");
  assert.equal(inv[0].using_default, 500);
  assert.ok(!logs.join("\n").includes("lots-SECRETISH"), "raw value is not logged");
  rroResetIsolateStateForTests();
});

test("P68/P75: volume alert at an absolute 20 starts (throttled); over the cap -> 503, no Stripe call, cap hits escalate but are throttled", async () => {
  rroResetIsolateStateForTests();
  const e = env({ RRO_CHECKOUT_DAILY_CAP: "25" });
  stripeOk();
  let logs = await captureLogs(async () => {
    for (let i = 0; i < 25; i++) assert.equal((await worker.fetch(checkout(), e)).status, 200, "#" + i);
  });
  assert.equal(stripeCalls.length, 25);
  const high = alerts(logs).filter((x) => x.alert === "checkout_daily_volume_high");
  assert.equal(high.length, 1, "throttled to one line");
  assert.equal(high[0].n, 20, "first alert at 20 starts, not a fraction of the cap");
  assert.equal(high[0].cap, 25);
  const rs = [];
  logs = await captureLogs(async () => { for (let i = 0; i < 3; i++) rs.push(await worker.fetch(checkout(), e)); });
  for (const r of rs) {
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { status: "error", error: "CHECKOUT_UNAVAILABLE" });
  }
  assert.equal(stripeCalls.length, 25, "no Stripe call over the cap");
  const hits = alerts(logs).filter((x) => x.alert === "checkout_daily_cap_hit");
  assert.equal(hits.length, 1, "P75: three capped calls within 60 s give ONE line");
  assert.ok(hits[0].cap === 25 && hits[0].escalate === true);
  const row = daily(e);
  assert.equal(row.key_hash, "global");
  assert.equal(row.n, 25, "nothing written over the cap");
  assert.equal(row.window_start_utc, new Date().toISOString().slice(0, 10) + "T00:00:00.000Z", "window is the UTC day");
});

test("P68: a configured cap below 20 alerts at the cap itself", async () => {
  rroResetIsolateStateForTests();
  const e = env({ RRO_CHECKOUT_DAILY_CAP: "3" });
  stripeOk();
  const logs = await captureLogs(async () => { for (let i = 0; i < 3; i++) assert.equal((await worker.fetch(checkout(), e)).status, 200); });
  const high = alerts(logs).filter((x) => x.alert === "checkout_daily_volume_high");
  assert.equal(high.length, 1);
  assert.equal(high[0].n, 3);
});

test("P53: a counter error fails closed for a new session (503, no Stripe call)", async () => {
  const e = env();
  const db = e.RRO_CHECKOUT_DB;
  for (const s of RRO_CHECKOUT_SCHEMA) db._db.exec(s);
  e.RRO_CHECKOUT_DB = failBucket(db, "checkout_daily");
  noStripe();
  let r;
  const logs = await captureLogs(async () => { r = await worker.fetch(checkout(), e); });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { status: "error", error: "CHECKOUT_UNAVAILABLE" });
  assert.equal(stripeCalls.length, 0);
  assert.ok(alerts(logs).some((x) => x.alert === "checkout_daily_counter_failed"));
});

test("P53: the per-IP limit runs first, so one IP's refused requests never use up the day's budget", async () => {
  const e = env();
  stripeOk();
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await worker.fetch(checkout("203.0.113.99"), e)).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429, 429]);
  assert.equal(daily(e).n, 5);
});

test("P53: the next UTC day starts a fresh count; the hourly purge keeps today's row and drops it after 48 h", async () => {
  const e = env({ RRO_CHECKOUT_DAILY_CAP: "1" });
  stripeOk();
  const day0 = Date.UTC(2027, 0, 5);
  await withNow(day0 + 3600000, async () => assert.equal((await worker.fetch(checkout(), e)).status, 200));
  await withNow(day0 + 2 * 3600000, async () => assert.equal((await worker.fetch(checkout(), e)).status, 503));
  // An unrelated 10-minute counter row from the same morning, for contrast.
  e.RRO_CHECKOUT_DB._db.prepare("INSERT INTO rro_rate_counters (bucket, key_hash, window_start_utc, n) VALUES ('public_api','k',?,3)").run(new Date(day0 + 3600000).toISOString());
  await withNow(day0 + 20 * 3600000, () => worker.scheduled({}, e));
  assert.equal(daily(e).n, 1, "daily row survives the hourly purge all day");
  assert.ok(!counters(e).some((c) => c.bucket === "public_api"), "10-minute rows are still purged after 1 h");
  await withNow(day0 + 25 * 3600000, async () => assert.equal((await worker.fetch(checkout(), e)).status, 200, "new UTC day"));
  assert.equal(counters(e).filter((c) => c.bucket === "checkout_daily").length, 2);
  await withNow(day0 + 73 * 3600000, () => worker.scheduled({}, e));
  assert.equal(counters(e).filter((c) => c.bucket === "checkout_daily").length, 0, "dropped after 48 h");
  assert.equal(rroWindowStartIso(RRO_CHECKOUT_DAILY_WINDOW_MINUTES, day0 + 23 * 3600000), "2027-01-05T00:00:00.000Z");
});

test("P53: paid buyers are never affected: with the day's cap used up the pack still loads", async () => {
  const e = env({ RRO_CHECKOUT_DAILY_CAP: "1" });
  stripeOk();
  assert.equal((await worker.fetch(checkout(), e)).status, 200);
  assert.equal((await worker.fetch(checkout(), e)).status, 503);
  const sid = "cs_test_P53PAIDBUYER00000001";
  seedStart(e, sid);
  mockStripe(() => jsonResp(paidSession(sid)));
  assert.equal((await worker.fetch(get("/api/rro/pack?session_id=" + sid), e)).status, 200);
  assert.equal(daily(e).n, 1, "pack lookups never touch the daily counter");
});

test("P75: two capped calls produce one log line; the next line after the quiet window carries the suppressed count", async () => {
  rroResetIsolateStateForTests();
  const e = env({ RRO_CHECKOUT_DAILY_CAP: "1" });
  stripeOk();
  const t0 = Date.UTC(2027, 1, 3, 9);
  await withNow(t0, async () => assert.equal((await worker.fetch(checkout(), e)).status, 200));
  let logs = await captureLogs(async () => {
    await withNow(t0 + 1000, async () => assert.equal((await worker.fetch(checkout(), e)).status, 503));
    await withNow(t0 + 2000, async () => assert.equal((await worker.fetch(checkout(), e)).status, 503));
  });
  let hits = alerts(logs).filter((x) => x.alert === "checkout_daily_cap_hit");
  assert.equal(hits.length, 1, "one line for two capped calls");
  assert.equal(hits[0].escalate, true);
  logs = await captureLogs(() => withNow(t0 + 70000, async () => assert.equal((await worker.fetch(checkout(), e)).status, 503)));
  hits = alerts(logs).filter((x) => x.alert === "checkout_daily_cap_hit");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].suppressed, 1);
  assert.equal(stripeCalls.length, 1, "Stripe called only for the one admitted start");
});

test("P77: boolean true and whitespace-only caps are invalid (alert once, type/length only), not 'unset'", async () => {
  for (const [bad, type, len] of [[true, "boolean", 4], ["   ", "string", 3], [{}, "object", 15], [false, "boolean", 5]]) {
    rroResetIsolateStateForTests();
    const logs = await captureLogs(async () => {
      assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: bad }), 500);
      assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: bad }), 500);
    });
    const inv = alerts(logs).filter((x) => x.alert === "checkout_daily_cap_invalid");
    assert.equal(inv.length, 1, JSON.stringify(bad));
    assert.equal(inv[0].value_type, type);
    assert.equal(inv[0].value_length, len);
    assert.equal(inv[0].value, undefined, "the value itself is never logged");
  }
  rroResetIsolateStateForTests();
  const logs = await captureLogs(async () => { for (const unset of [undefined, null, ""]) assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: unset }), 500); });
  assert.equal(alerts(logs).length, 0, "only undefined, null and empty string are 'unset'");
});
