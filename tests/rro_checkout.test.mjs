// node --test tests/  — IDEA-03 £24 Stripe Checkout (no network; Stripe API is mocked).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import worker from "../worker.js";

const ORIGIN = "https://parish.technoplusit.co.uk";
const FAKE_KEY = "sk_test_" + "FAKEFAKEFAKE0123456789";
const FAKE_WHSEC = "whsec_" + "unit_test_only_not_a_real_secret";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const norm = (sql) => sql.replace(/\?(\d+)/g, "?");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(norm(sql)).get(...args) ?? null,
    all: async () => ({ results: db.prepare(norm(sql)).all(...args) }),
    run: async () => {
      const r = db.prepare(norm(sql)).run(...args);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return { prepare: (sql) => stmt(sql), batch: async (stmts) => Promise.all(stmts.map((s) => s.run())), _db: db };
}

function env(overrides = {}) {
  return { STRIPE_SECRET_KEY: FAKE_KEY, STRIPE_WEBHOOK_SECRET: FAKE_WHSEC, RRO_CHECKOUT_DB: fakeD1(), ...overrides };
}

function paidSession(id = "cs_test_a1B2c3D4e5F6g7H8i9J0", extra = {}) {
  return {
    id, object: "checkout.session", payment_status: "paid", livemode: false,
    amount_total: 2400, currency: "gbp", created: Math.floor(Date.now() / 1000),
    metadata: { product: "idea03_formal_tribunal_appeal_pack", region: "London", party_role: "landlord_defence", monthly_rent_gbp: "1800", months_unlicensed: "12", universal_credit_housing_gbp: "0", utilities_included_monthly_gbp: "150", mitigation_factors: "good_condition" },
    ...extra,
  };
}

let stripeCalls = [];
function mockStripe(handler) {
  stripeCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    stripeCalls.push({ url: String(url), init });
    return handler(String(url), init);
  };
}
const jsonResp = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

function checkoutReq(body = {}, headers = {}) {
  return new Request(ORIGIN + "/api/rro/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.7", ...headers },
    body: JSON.stringify(body),
  });
}

function sign(payload, secret = FAKE_WHSEC, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", secret).update(t + "." + payload).digest("hex");
  return "t=" + t + ",v1=" + sig;
}
function webhookReq(event, sigHeader) {
  const payload = JSON.stringify(event);
  return new Request(ORIGIN + "/api/rro/stripe-webhook", { method: "POST", headers: { "Stripe-Signature": sigHeader ?? sign(payload), "Content-Type": "application/json" }, body: payload });
}

test("checkout fails closed (503) without STRIPE_SECRET_KEY and never calls Stripe", async () => {
  mockStripe(() => { throw new Error("must not call Stripe"); });
  const r = await worker.fetch(checkoutReq(), env({ STRIPE_SECRET_KEY: undefined }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).detail, "STRIPE_SECRET_KEY_MISSING");
  assert.equal(stripeCalls.length, 0);
});

test("checkout fails closed without D1 binding or webhook secret", async () => {
  mockStripe(() => { throw new Error("must not call Stripe"); });
  assert.equal((await worker.fetch(checkoutReq(), env({ RRO_CHECKOUT_DB: undefined }))).status, 503);
  assert.equal((await worker.fetch(checkoutReq(), env({ STRIPE_WEBHOOK_SECRET: undefined }))).status, 503);
});

test("live key refused unless RRO_STRIPE_LIVE_ENABLED=true (Worf gate)", async () => {
  mockStripe(() => { throw new Error("must not call Stripe"); });
  const r = await worker.fetch(checkoutReq(), env({ STRIPE_SECRET_KEY: "sk_live_" + "FAKE0123456789" }));
  assert.equal(r.status, 503);
  assert.equal((await r.json()).detail, "LIVE_KEY_PRESENT_BUT_RRO_STRIPE_LIVE_ENABLED_NOT_TRUE");
});

test("checkout rejects cross-origin and missing Origin (CSRF) and GET", async () => {
  mockStripe(() => { throw new Error("must not call Stripe"); });
  assert.equal((await worker.fetch(checkoutReq({}, { Origin: "https://evil.example" }), env())).status, 403);
  const noOrigin = new Request(ORIGIN + "/api/rro/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal((await worker.fetch(noOrigin, env())).status, 403);
  assert.equal((await worker.fetch(new Request(ORIGIN + "/api/rro/checkout"), env())).status, 405);
});

test("checkout creates £24 GBP session, returns checkout.stripe.com url, counts a start", async () => {
  mockStripe((url, init) => {
    assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
    const f = new URLSearchParams(init.body);
    assert.equal(f.get("mode"), "payment");
    assert.equal(f.get("line_items[0][price_data][unit_amount]"), "2400");
    assert.equal(f.get("line_items[0][price_data][currency]"), "gbp");
    assert.equal(f.get("line_items[0][price_data][product_data][name]"), "Export Formal Tribunal Appeal Pack");
    assert.equal(f.get("success_url"), ORIGIN + "/rro/pack/success?session_id={CHECKOUT_SESSION_ID}");
    assert.ok(f.get("cancel_url").startsWith(ORIGIN + "/rro"));
    assert.equal(f.get("metadata[region]"), "Northern");
    assert.ok(init.headers["Idempotency-Key"]);
    return jsonResp({ id: "cs_test_SESSION0000000001", url: "https://checkout.stripe.com/c/pay/cs_test_SESSION0000000001" });
  });
  const e = env();
  const r = await worker.fetch(checkoutReq({ region: "Northern", monthly_rent_gbp: "900" }), e);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.url.startsWith("https://checkout.stripe.com/"));
  assert.equal(body.mode, "test");
  const t = await (await worker.fetch(new Request(ORIGIN + "/api/rro/telemetry"), e)).json();
  assert.equal(t.checkout_starts, 1);
  assert.equal(t.paid, 0);
});

test("checkout refuses a non-Stripe redirect url (no open redirect)", async () => {
  mockStripe(() => jsonResp({ id: "cs_test_SESSION0000000002", url: "https://evil.example/pay" }));
  const r = await worker.fetch(checkoutReq(), env());
  assert.equal(r.status, 502);
});

test("checkout start is rate-limited per hashed IP", async () => {
  let n = 0;
  mockStripe(() => { n++; return jsonResp({ id: "cs_test_RATE" + String(n).padStart(12, "0"), url: "https://checkout.stripe.com/c/pay/x" + n }); });
  const e = env();
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(checkoutReq(), e)).status, 200);
  const r = await worker.fetch(checkoutReq(), e);
  assert.equal(r.status, 429);
  assert.equal(n, 5);
  const other = await worker.fetch(checkoutReq({}, { "CF-Connecting-IP": "198.51.100.9" }), e);
  assert.equal(other.status, 200);
  const raw = e.RRO_CHECKOUT_DB._db.prepare("SELECT ip_hash FROM rro_checkout_events").all();
  assert.ok(raw.every((row) => !String(row.ip_hash).includes("203.0.113.7")));
});

test("webhook rejects missing, bad, wrong-secret and stale signatures", async () => {
  const e = env();
  const event = { type: "checkout.session.completed", data: { object: paidSession() } };
  const payload = JSON.stringify(event);
  assert.equal((await worker.fetch(webhookReq(event, ""), e)).status, 400);
  assert.equal((await worker.fetch(webhookReq(event, "t=1,v1=deadbeef"), e)).status, 400);
  assert.equal((await worker.fetch(webhookReq(event, sign(payload, "whsec_wrong")), e)).status, 400);
  assert.equal((await worker.fetch(webhookReq(event, sign(payload, FAKE_WHSEC, Math.floor(Date.now() / 1000) - 3600)), e)).status, 400);
  const t = await (await worker.fetch(new Request(ORIGIN + "/api/rro/telemetry"), e)).json();
  assert.equal(t.paid, 0);
});

test("webhook fails closed without STRIPE_WEBHOOK_SECRET", async () => {
  const event = { type: "checkout.session.completed", data: { object: paidSession() } };
  assert.equal((await worker.fetch(webhookReq(event), env({ STRIPE_WEBHOOK_SECRET: undefined }))).status, 503);
});

test("paid counter is idempotent on session id (webhook replay + success page)", async () => {
  const e = env();
  const session = paidSession("cs_test_IDEMPOTENT0000001");
  const event = { type: "checkout.session.completed", data: { object: session } };
  const r1 = await (await worker.fetch(webhookReq(event), e)).json();
  const r2 = await (await worker.fetch(webhookReq(event), e)).json();
  assert.equal(r1.recorded, true);
  assert.equal(r2.duplicate, true);
  mockStripe(() => jsonResp(session));
  const page = await worker.fetch(new Request(ORIGIN + "/rro/pack/success?session_id=" + session.id), e);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /TEST MODE/);
  const t = await (await worker.fetch(new Request(ORIGIN + "/api/rro/telemetry"), e)).json();
  assert.equal(t.paid, 1);
});

test("webhook ignores unpaid / wrong-amount / other-product sessions", async () => {
  const e = env();
  for (const s of [paidSession("cs_test_UNPAID00000000001", { payment_status: "unpaid" }), paidSession("cs_test_WRONGAMT000000001", { amount_total: 100 }), paidSession("cs_test_OTHERPRD000000001", { metadata: { product: "x" } })]) {
    const r = await (await worker.fetch(webhookReq({ type: "checkout.session.completed", data: { object: s } }), e)).json();
    assert.equal(r.ignored, true);
  }
  const t = await (await worker.fetch(new Request(ORIGIN + "/api/rro/telemetry"), e)).json();
  assert.equal(t.paid, 0);
});

test("pack download requires a verified paid session and returns the formal pack", async () => {
  const e = env();
  const session = paidSession("cs_test_DOWNLOAD000000001");
  mockStripe(() => jsonResp({ ...session, payment_status: "unpaid" }));
  assert.equal((await worker.fetch(new Request(ORIGIN + "/api/rro/pack?session_id=" + session.id), e)).status, 402);
  assert.equal((await worker.fetch(new Request(ORIGIN + "/api/rro/pack?session_id=../../etc"), e)).status, 400);
  assert.equal((await worker.fetch(new Request(ORIGIN + "/api/rro/pack?session_id=cs_live_ABCDEFGHIJKLMN"), e)).status, 400);
  mockStripe(() => jsonResp(session));
  const md = await worker.fetch(new Request(ORIGIN + "/api/rro/pack?format=md&session_id=" + session.id), e);
  assert.equal(md.status, 200);
  const text = await md.text();
  assert.match(text, /^# Formal Tribunal Appeal Pack/);
  assert.match(text, /Scott Schedule/);
  assert.match(md.headers.get("Content-Disposition"), /attachment; filename="formal-tribunal-appeal-pack-london-/);
  const csv = await worker.fetch(new Request(ORIGIN + "/api/rro/pack?format=csv&session_id=" + session.id), e);
  assert.match(await csv.text(), /case_ref,region/);
});

test("telemetry shape: counts, since, day7 kill rule, no secrets", async () => {
  const e = env({ RRO_CHECKOUT_LIVE_SINCE: "2026-11-05T12:00:00Z" });
  const r = await worker.fetch(new Request(ORIGIN + "/api/rro/telemetry"), e);
  assert.equal(r.status, 200);
  const raw = await r.text();
  assert.ok(!raw.includes(FAKE_KEY) && !raw.includes(FAKE_WHSEC) && !/sk_(test|live)_|whsec_/.test(raw));
  const t = JSON.parse(raw);
  for (const k of ["checkout_starts", "paid", "since", "day7_kill_rule", "stripe_mode", "by_mode"]) assert.ok(k in t, k);
  assert.equal(t.since, "2026-11-05T12:00:00.000Z");
  assert.equal(t.day7_kill_rule.min_checkout_starts, 10);
  assert.equal(t.day7_kill_rule.min_paid, 1);
  assert.equal(t.day7_kill_rule.evaluate_at_utc, "2026-11-12T12:00:00.000Z");
  assert.equal(t.stripe_mode, "test");
});

test("telemetry without LIVE_SINCE reports clock_not_started; unconfigured mode when no key", async () => {
  const t = await (await worker.fetch(new Request(ORIGIN + "/api/rro/telemetry"), env({ STRIPE_SECRET_KEY: undefined }))).json();
  assert.equal(t.day7_kill_rule.verdict, "clock_not_started");
  assert.equal(t.stripe_mode, "unconfigured");
  assert.equal(t.since, null);
});

test("/rro page has the £24 CTA and CSP allows Stripe Checkout form-action", async () => {
  const r = await worker.fetch(new Request(ORIGIN + "/rro"), {});
  const html = await r.text();
  assert.match(html, /Export Formal Tribunal Appeal Pack — £24/);
  assert.match(html, /\/api\/rro\/checkout/);
  assert.doesNotMatch(html, /Dossier Pack \(£29\)/);
  assert.match(r.headers.get("Content-Security-Policy"), /form-action 'self' https:\/\/checkout\.stripe\.com/);
});
