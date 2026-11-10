// Shared fixtures for the pre-LIVE batch tests (rro_p2_p3, rro_p15_p16, rro_p39_csp). Not a test file itself.
// No network: Stripe is mocked through globalThis.fetch.
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { rroResetIsolateStateForTests, RRO_CHECKOUT_SCHEMA } from "../src/rro_core.js";

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

export { ORIGIN, FAKE_KEY, FAKE_WHSEC, FAKE_PEPPER, IP, fakeD1, configuredEnv, disabledEnv, get, post, stripeCalls, mockStripe, noStripe, jsonResp, paidSession, seedStart, sign, webhookReq, counters, withNow, captureLogs, PUBLIC_CODES };
