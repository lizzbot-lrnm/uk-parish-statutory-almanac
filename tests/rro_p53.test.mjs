// node --test tests/  — P53: global daily ceiling on new Stripe Checkout sessions (fail closed, no Stripe call
// over the cap or on a counter error), volume alerts, purge retention, paid buyers unaffected. No network.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../worker.js";
import { rroCheckoutDailyCap, rroWindowStartIso, RRO_CHECKOUT_DAILY_CAP_DEFAULT, RRO_CHECKOUT_DAILY_WINDOW_MINUTES, RRO_ALERT_EVENT, RRO_CHECKOUT_SCHEMA } from "../src/rro_core.js";
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

test("P53: the cap is a named default (50), overridable by a plain var, and never 'unlimited' on bad input", () => {
  assert.equal(RRO_CHECKOUT_DAILY_CAP_DEFAULT, 50);
  assert.equal(rroCheckoutDailyCap({}), 50);
  assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: "200" }), 200);
  assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: " 75 " }), 75);
  assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: 7 }), 7);
  for (const bad of ["0", "-1", "abc", "1e3", "99999", "", "Infinity", "12.5", null, true]) assert.equal(rroCheckoutDailyCap({ RRO_CHECKOUT_DAILY_CAP: bad }), 50, String(bad));
  const doc = readFileSync(new URL("../deploy/RRO_STRIPE_CHECKOUT.md", import.meta.url), "utf8");
  assert.match(doc, /`RRO_CHECKOUT_DAILY_CAP`/);
  assert.match(doc, /The default is \*\*50\*\* new checkout sessions per UTC day/);
});

test("P53: over the daily cap -> generic 503, Stripe never called, cap-hit and volume alerts logged (throttled)", async () => {
  const e = env({ RRO_CHECKOUT_DAILY_CAP: "4" });
  stripeOk();
  let logs = await captureLogs(async () => {
    for (let i = 0; i < 4; i++) assert.equal((await worker.fetch(checkout(), e)).status, 200, "#" + i);
  });
  assert.equal(stripeCalls.length, 4);
  const high = alerts(logs).filter((x) => x.alert === "checkout_daily_volume_high");
  assert.equal(high.length, 1, "throttled to one line");
  assert.equal(high[0].n, 2, "first alert at 50% of the cap");
  assert.equal(high[0].cap, 4);
  let r;
  logs = await captureLogs(async () => { r = await worker.fetch(checkout(), e); });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { status: "error", error: "CHECKOUT_UNAVAILABLE" });
  assert.equal(stripeCalls.length, 4, "no Stripe call over the cap");
  const hit = alerts(logs).find((x) => x.alert === "checkout_daily_cap_hit");
  assert.ok(hit && hit.cap === 4);
  const row = daily(e);
  assert.equal(row.key_hash, "global");
  assert.equal(row.n, 4, "nothing written over the cap");
  assert.equal(row.window_start_utc, new Date().toISOString().slice(0, 10) + "T00:00:00.000Z", "window is the UTC day");
});

test("P53: a counter error fails closed for a new session (503, no Stripe call)", async () => {
  const e = env();
  const db = e.RRO_CHECKOUT_DB;
  for (const s of RRO_CHECKOUT_SCHEMA) db._db.exec(s);
  e.RRO_CHECKOUT_DB = { ...db, prepare: (sql) => (/rro_rate_counters/.test(sql) && /^\s*INSERT/i.test(sql) ? { bind: () => ({ first: async () => { throw new Error("D1_ERROR: write failed"); } }) } : db.prepare(sql)) };
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
