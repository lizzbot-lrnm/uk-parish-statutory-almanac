// node --test tests/  — £24 RRO Stripe Checkout (no network; Stripe API is mocked).
// Covers test-mode conditions T1–T5 plus the original 15 behaviours.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import worker from "../worker.js";

const ORIGIN = "https://parish.technoplusit.co.uk";
const FAKE_KEY = "sk_test_" + "FAKEFAKEFAKE0123456789";
const FAKE_LIVE_KEY = "sk_live_" + "FAKE0123456789";
const FAKE_WHSEC = "whsec_" + "unit_test_only_not_a_real_secret";
const FAKE_PEPPER = "unit-test-pepper-" + "not-a-real-secret-000";
const FAKE_TELEMETRY_TOKEN = "unit-test-telemetry-" + "token-not-real-0000";
const FAKE_PREVIEW_SECRET = "unit-test-preview-" + "secret-not-real-000000";
const hmacHex = (k, m) => crypto.createHmac("sha256", k).update(m).digest("hex");
const PREVIEW_LINK_TOKEN = hmacHex(FAKE_PREVIEW_SECRET, "rro-preview-link-v1");
const previewCookie = (exp = Math.floor(Date.now() / 1000) + 3600, secret = FAKE_PREVIEW_SECRET) =>
  "rro_preview=" + exp + "." + hmacHex(secret, "rro-preview-cookie-v1:" + exp);
const PREVIEW = { Cookie: previewCookie() };

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  // D1 is SQLite: numbered ?NNN params bind by index (and may repeat), exactly as node:sqlite does.
  const norm = (sql) => sql;
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
  return { STRIPE_SECRET_KEY: FAKE_KEY, STRIPE_WEBHOOK_SECRET: FAKE_WHSEC, RRO_IP_PEPPER: FAKE_PEPPER, RRO_PREVIEW_SECRET: FAKE_PREVIEW_SECRET, RRO_CHECKOUT_DB: fakeD1(), ...overrides };
}

function paidSession(id = "cs_test_a1B2c3D4e5F6g7H8i9J0", extra = {}) {
  return {
    id, object: "checkout.session", payment_status: "paid", livemode: false,
    amount_total: 2400, currency: "gbp", created: Math.floor(Date.now() / 1000),
    metadata: { product: "tribunal_appeal_pack", region: "London", party_role: "landlord_defence", monthly_rent_gbp: "1800", months_unlicensed: "12", universal_credit_housing_gbp: "0", utilities_included_monthly_gbp: "150", mitigation_factors: "good_condition" },
    ...extra,
  };
}

// Seed a known session row in D1 (as /api/rro/checkout would) so lookups pass the D1-first gate.
function seedStart(e, sid, mode = "test") {
  e.RRO_CHECKOUT_DB._db
    .prepare("CREATE TABLE IF NOT EXISTS rro_checkout_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('checkout_start','paid')), stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('test','live')), session_id TEXT, ip_hash TEXT, amount_total INTEGER, currency TEXT, created_at_utc TEXT NOT NULL)")
    .run();
  e.RRO_CHECKOUT_DB._db
    .prepare("INSERT INTO rro_checkout_events (kind, stripe_mode, session_id, ip_hash, amount_total, currency, created_at_utc) VALUES ('checkout_start', ?, ?, 'seed', 2400, 'gbp', ?)")
    .run(mode, sid, new Date().toISOString());
}

let stripeCalls = [];
function mockStripe(handler) {
  stripeCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    stripeCalls.push({ url: String(url), init });
    return handler(String(url), init);
  };
}
const noStripe = () => mockStripe(() => { throw new Error("must not call Stripe"); });
const jsonResp = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

function checkoutReq(body = {}, headers = {}) {
  return new Request(ORIGIN + "/api/rro/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.7", ...PREVIEW, ...headers },
    body: JSON.stringify(body),
  });
}
const getReq = (path, headers = {}) => new Request(ORIGIN + path, { headers: { "CF-Connecting-IP": "203.0.113.7", ...headers } });
const fullTelemetry = async (e) =>
  (await worker.fetch(getReq("/api/rro/telemetry", { Authorization: "Bearer " + FAKE_TELEMETRY_TOKEN }), { ...e, RRO_TELEMETRY_TOKEN: FAKE_TELEMETRY_TOKEN })).json();

function sign(payload, secret = FAKE_WHSEC, t = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac("sha256", secret).update(t + "." + payload).digest("hex");
  return "t=" + t + ",v1=" + sig;
}
function webhookReq(event, sigHeader, extraHeaders = {}) {
  const payload = JSON.stringify(event);
  return new Request(ORIGIN + "/api/rro/stripe-webhook", { method: "POST", headers: { "Stripe-Signature": sigHeader ?? sign(payload), "Content-Type": "application/json", ...extraHeaders }, body: payload });
}

// ---------------------------------------------------------------- fail-closed / T5 generic errors
test("checkout fails closed (503 generic CHECKOUT_NOT_CONFIGURED, no detail) without STRIPE_SECRET_KEY; never calls Stripe", async () => {
  noStripe();
  const r = await worker.fetch(checkoutReq(), env({ STRIPE_SECRET_KEY: undefined }));
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.deepEqual(body, { status: "error", error: "CHECKOUT_NOT_CONFIGURED" });
  assert.equal(stripeCalls.length, 0);
});

test("checkout fails closed without D1 binding, webhook secret or IP pepper — all generic", async () => {
  noStripe();
  for (const o of [{ RRO_CHECKOUT_DB: undefined }, { STRIPE_WEBHOOK_SECRET: undefined }, { RRO_IP_PEPPER: undefined }]) {
    const r = await worker.fetch(checkoutReq(), env(o));
    assert.equal(r.status, 503);
    const raw = await r.text();
    assert.ok(!/detail|BINDING|MISSING|WEBHOOK|PEPPER|RRO_/.test(raw), raw);
  }
  assert.equal(stripeCalls.length, 0);
});

// ---------------------------------------------------------------- T4 exact live flag
test("T4: live key only enabled by exact RRO_STRIPE_LIVE_ENABLED === 'true' (TRUE/True/' true'/'1' refused)", async () => {
  noStripe();
  for (const flag of [undefined, "1", " true", "true ", "TRUE", "True", "yes"]) {
    const r = await worker.fetch(checkoutReq(), env({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY, RRO_STRIPE_LIVE_ENABLED: flag }));
    assert.equal(r.status, 503, "flag " + JSON.stringify(flag));
    assert.deepEqual(await r.json(), { status: "error", error: "CHECKOUT_NOT_CONFIGURED" });
  }
  assert.equal(stripeCalls.length, 0);
  mockStripe(() => jsonResp({ id: "cs_live_LIVEOK00000000001", url: "https://checkout.stripe.com/c/pay/cs_live_LIVEOK00000000001" }));
  const ok = await worker.fetch(checkoutReq({}, { Cookie: "" }), env({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY, RRO_STRIPE_LIVE_ENABLED: "true" }));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).mode, "live");
  assert.equal(new URLSearchParams(stripeCalls[0].init.body).get("custom_text[submit][message]"), null);
});

test("checkout rejects cross-origin and missing Origin (CSRF) and GET", async () => {
  noStripe();
  assert.equal((await worker.fetch(checkoutReq({}, { Origin: "https://evil.example" }), env())).status, 403);
  const noOrigin = new Request(ORIGIN + "/api/rro/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal((await worker.fetch(noOrigin, env())).status, 403);
  assert.equal((await worker.fetch(new Request(ORIGIN + "/api/rro/checkout"), env())).status, 405);
});

// ---------------------------------------------------------------- T1 test-mode preview gate
test("T1: test-mode checkout requires the preview cookie (no cookie -> 503, Stripe not called)", async () => {
  noStripe();
  const r = await worker.fetch(checkoutReq({}, { Cookie: "" }), env());
  assert.equal(r.status, 503);
  assert.equal(stripeCalls.length, 0);
});

test("checkout creates £24 GBP session with TEST MODE submit text, returns checkout.stripe.com url, counts a start", async () => {
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
    assert.match(f.get("custom_text[submit][message]"), /TEST MODE – no real payment; do not enter real card details/);
    assert.ok(init.headers["Idempotency-Key"]);
    return jsonResp({ id: "cs_test_SESSION0000000001", url: "https://checkout.stripe.com/c/pay/cs_test_SESSION0000000001" });
  });
  const e = env();
  const r = await worker.fetch(checkoutReq({ region: "Northern", monthly_rent_gbp: "900" }), e);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.url.startsWith("https://checkout.stripe.com/"));
  assert.equal(body.mode, "test");
  const t = await fullTelemetry(e);
  assert.equal(t.checkout_starts, 1);
  assert.equal(t.paid, 0);
});

test("checkout refuses a non-Stripe redirect url (no open redirect); failure body has no stripe_status", async () => {
  mockStripe(() => jsonResp({ id: "cs_test_SESSION0000000002", url: "https://evil.example/pay" }));
  const r = await worker.fetch(checkoutReq(), env());
  assert.equal(r.status, 502);
  mockStripe(() => jsonResp({ error: { message: "x" } }, 401));
  const r2 = await worker.fetch(checkoutReq(), env());
  assert.deepEqual(await r2.json(), { status: "error", error: "STRIPE_SESSION_CREATE_FAILED" });
});

test("checkout start is rate-limited per hashed IP, slot reserved before Stripe (failures count)", async () => {
  let n = 0;
  mockStripe(() => { n++; return n <= 2 ? jsonResp({}, 500) : jsonResp({ id: "cs_test_RATE" + String(n).padStart(12, "0"), url: "https://checkout.stripe.com/c/pay/x" + n }); });
  const e = env();
  assert.equal((await worker.fetch(checkoutReq(), e)).status, 502);
  assert.equal((await worker.fetch(checkoutReq(), e)).status, 502);
  for (let i = 0; i < 3; i++) assert.equal((await worker.fetch(checkoutReq(), e)).status, 200);
  const r = await worker.fetch(checkoutReq(), e);
  assert.equal(r.status, 429);
  assert.equal(n, 5);
  const other = await worker.fetch(checkoutReq({}, { "CF-Connecting-IP": "198.51.100.9" }), e);
  assert.equal(other.status, 200);
});

// ---------------------------------------------------------------- T3 HMAC pepper + purge
test("T3: ip_hash is HMAC-SHA256(RRO_IP_PEPPER, day:ip), not the old public-salt sha256; raw IP never stored", async () => {
  mockStripe(() => jsonResp({ id: "cs_test_HMAC00000000000001", url: "https://checkout.stripe.com/c/pay/h" }));
  const e = env();
  assert.equal((await worker.fetch(checkoutReq(), e)).status, 200);
  const row = e.RRO_CHECKOUT_DB._db.prepare("SELECT ip_hash FROM rro_checkout_events WHERE kind='checkout_start'").get();
  const day = new Date().toISOString().slice(0, 10);
  const expected = crypto.createHmac("sha256", FAKE_PEPPER).update(day + ":203.0.113.7").digest("hex").slice(0, 32);
  const oldStyle = crypto.createHash("sha256").update("rro-checkout:" + day + ":203.0.113.7").digest("hex").slice(0, 24);
  assert.equal(row.ip_hash, expected);
  assert.notEqual(row.ip_hash, oldStyle);
  assert.ok(!String(row.ip_hash).includes("203.0.113.7"));
});

test("T3: pepper required — missing, short, or equal to the whsec fails closed on checkout and pack lookup", async () => {
  noStripe();
  for (const pepper of [undefined, "", "short", FAKE_WHSEC]) {
    const e = env({ RRO_IP_PEPPER: pepper });
    assert.equal((await worker.fetch(checkoutReq(), e)).status, 503, "pepper " + JSON.stringify(pepper));
    seedStart(e, "cs_test_PEPPERLESS0000001");
    assert.equal((await worker.fetch(getReq("/api/rro/pack?session_id=cs_test_PEPPERLESS0000001"), e)).status, 503);
  }
  assert.equal(stripeCalls.length, 0);
});

test("T3: ip_hash older than 48h is NULLed (on-write and via scheduled())", async () => {
  const e = env();
  seedStart(e, "cs_test_OLDROW0000000001");
  const db = e.RRO_CHECKOUT_DB._db;
  db.prepare("UPDATE rro_checkout_events SET created_at_utc = ? WHERE session_id = ?").run(new Date(Date.now() - 49 * 3600000).toISOString(), "cs_test_OLDROW0000000001");
  seedStart(e, "cs_test_NEWROW0000000001");
  await worker.scheduled({}, e);
  assert.equal(db.prepare("SELECT ip_hash FROM rro_checkout_events WHERE session_id = ?").get("cs_test_OLDROW0000000001").ip_hash, null);
  assert.equal(db.prepare("SELECT ip_hash FROM rro_checkout_events WHERE session_id = ?").get("cs_test_NEWROW0000000001").ip_hash, "seed");
  // on-write purge: a fresh checkout also purges
  db.prepare("UPDATE rro_checkout_events SET ip_hash = 'seed', created_at_utc = ? WHERE session_id = ?").run(new Date(Date.now() - 72 * 3600000).toISOString(), "cs_test_NEWROW0000000001");
  mockStripe(() => jsonResp({ id: "cs_test_PURGEWRITE000001", url: "https://checkout.stripe.com/c/pay/p" }));
  assert.equal((await worker.fetch(checkoutReq(), e)).status, 200);
  assert.equal(db.prepare("SELECT ip_hash FROM rro_checkout_events WHERE session_id = ?").get("cs_test_NEWROW0000000001").ip_hash, null);
});

// ---------------------------------------------------------------- webhook
test("webhook rejects missing, bad, wrong-secret and stale signatures", async () => {
  const e = env();
  const event = { type: "checkout.session.completed", data: { object: paidSession() } };
  const payload = JSON.stringify(event);
  assert.equal((await worker.fetch(webhookReq(event, ""), e)).status, 400);
  assert.equal((await worker.fetch(webhookReq(event, "t=1,v1=deadbeef"), e)).status, 400);
  assert.equal((await worker.fetch(webhookReq(event, sign(payload, "whsec_wrong")), e)).status, 400);
  assert.equal((await worker.fetch(webhookReq(event, sign(payload, FAKE_WHSEC, Math.floor(Date.now() / 1000) - 3600)), e)).status, 400);
  const t = await fullTelemetry(e);
  assert.equal(t.paid, 0);
});

test("webhook refuses oversize Content-Length before reading (W-L2)", async () => {
  const event = { type: "checkout.session.completed", data: { object: paidSession() } };
  const r = await worker.fetch(webhookReq(event, undefined, { "Content-Length": String(300 * 1024) }), env());
  assert.equal(r.status, 413);
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
  const page = await worker.fetch(getReq("/rro/pack/success?session_id=" + session.id), e);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /TEST MODE/);
  const t = await fullTelemetry(e);
  assert.equal(t.paid, 1);
});

test("webhook ignores unpaid / wrong-amount / other-product sessions", async () => {
  const e = env();
  for (const s of [paidSession("cs_test_UNPAID00000000001", { payment_status: "unpaid" }), paidSession("cs_test_WRONGAMT000000001", { amount_total: 100 }), paidSession("cs_test_OTHERPRD000000001", { metadata: { product: "x" } })]) {
    const r = await (await worker.fetch(webhookReq({ type: "checkout.session.completed", data: { object: s } }), e)).json();
    assert.equal(r.ignored, true);
  }
  const t = await fullTelemetry(e);
  assert.equal(t.paid, 0);
});

// ---------------------------------------------------------------- T2 D1-first, cache, rate limit
test("T2: unknown session_id -> 404 on /api/rro/pack and /rro/pack/success with NO Stripe call", async () => {
  noStripe();
  const e = env();
  const r1 = await worker.fetch(getReq("/api/rro/pack?session_id=cs_test_UNKNOWNSESSION00001"), e);
  assert.equal(r1.status, 404);
  assert.equal((await r1.json()).error, "SESSION_NOT_FOUND");
  const r2 = await worker.fetch(getReq("/rro/pack/success?session_id=cs_live_UNKNOWNSESSION00002"), env({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY, RRO_STRIPE_LIVE_ENABLED: "true" }));
  assert.equal(r2.status, 404);
  assert.equal(stripeCalls.length, 0);
});

test("T2: paid verdict cached (<=10 min) — repeat downloads do not re-call Stripe", async () => {
  const e = env();
  const session = paidSession("cs_test_CACHEDPAID0000001");
  seedStart(e, session.id);
  mockStripe(() => jsonResp(session));
  assert.equal((await worker.fetch(getReq("/api/rro/pack?format=md&session_id=" + session.id), e)).status, 200);
  assert.equal((await worker.fetch(getReq("/api/rro/pack?format=csv&session_id=" + session.id), e)).status, 200);
  assert.equal((await worker.fetch(getReq("/rro/pack/success?session_id=" + session.id), e)).status, 200);
  assert.equal(stripeCalls.length, 1);
});

test("T2: per-ip_hash rate limit 30/10 min on pack + success lookups (429, no Stripe beyond)", async () => {
  noStripe();
  const e = env();
  let last;
  for (let i = 0; i < 30; i++) {
    last = await worker.fetch(getReq(i % 2 ? "/api/rro/pack?session_id=cs_test_FLOOD" + String(i).padStart(14, "0") : "/rro/pack/success?session_id=cs_test_FLOOD" + String(i).padStart(14, "0")), e);
    assert.equal(last.status, 404);
  }
  const limited = await worker.fetch(getReq("/api/rro/pack?session_id=cs_test_FLOODLAST0000001"), e);
  assert.equal(limited.status, 429);
  const otherIp = await worker.fetch(getReq("/api/rro/pack?session_id=cs_test_FLOODLAST0000001", { "CF-Connecting-IP": "198.51.100.77" }), e);
  assert.equal(otherIp.status, 404);
  assert.equal(stripeCalls.length, 0);
});

test("pack download requires a verified paid session and returns the formal pack", async () => {
  const e = env();
  const session = paidSession("cs_test_DOWNLOAD000000001");
  seedStart(e, session.id);
  mockStripe(() => jsonResp({ ...session, payment_status: "unpaid" }));
  assert.equal((await worker.fetch(getReq("/api/rro/pack?session_id=" + session.id), e)).status, 402);
  assert.equal((await worker.fetch(getReq("/api/rro/pack?session_id=../../etc"), e)).status, 400);
  assert.equal((await worker.fetch(getReq("/api/rro/pack?session_id=cs_live_ABCDEFGHIJKLMN"), e)).status, 400);
  mockStripe(() => jsonResp(session));
  const md = await worker.fetch(getReq("/api/rro/pack?format=md&session_id=" + session.id), e);
  assert.equal(md.status, 200);
  const text = await md.text();
  assert.match(text, /^# Formal Tribunal Appeal Pack/);
  assert.match(text, /Scott Schedule/);
  assert.match(md.headers.get("Content-Disposition"), /attachment; filename="formal-tribunal-appeal-pack-london-/);
  const csv = await worker.fetch(getReq("/api/rro/pack?format=csv&session_id=" + session.id), e);
  assert.match(await csv.text(), /case_ref,region/);
});

// ---------------------------------------------------------------- T5 telemetry
test("T5: public telemetry is stripped — status + mode label only; no counts, by_mode, day7, env/binding names", async () => {
  const e = env({ RRO_CHECKOUT_LIVE_SINCE: "2026-11-05T12:00:00Z" });
  const r = await worker.fetch(getReq("/api/rro/telemetry"), e);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  const raw = await r.text();
  assert.ok(!/sk_(test|live)_|whsec_|checkout_starts|paid|by_mode|day7|kill|live_blocked|RRO_|STRIPE_|detail/i.test(raw), raw);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["mode", "price_gbp", "product", "status"]);
  assert.equal(JSON.parse(raw).product, "tribunal_appeal_pack"); // generic public id, no internal codename
  assert.equal(JSON.parse(raw).mode, "test");
  // live key present but flag not set must not leak key presence
  const blocked = await (await worker.fetch(getReq("/api/rro/telemetry"), env({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY }))).json();
  assert.equal(blocked.mode, "unavailable");
  const noDb = await (await worker.fetch(getReq("/api/rro/telemetry"), env({ RRO_CHECKOUT_DB: undefined }))).json();
  assert.equal(noDb.mode, "unavailable");
  assert.ok(!("detail" in noDb));
});

test("T5: full telemetry only with correct bearer RRO_TELEMETRY_TOKEN (no CORS); wrong/absent token gets public view", async () => {
  const e = env({ RRO_CHECKOUT_LIVE_SINCE: "2026-11-05T12:00:00Z", RRO_TELEMETRY_TOKEN: FAKE_TELEMETRY_TOKEN });
  const wrong = await (await worker.fetch(getReq("/api/rro/telemetry", { Authorization: "Bearer nope" }), e)).json();
  assert.ok(!("checkout_starts" in wrong));
  const r = await worker.fetch(getReq("/api/rro/telemetry", { Authorization: "Bearer " + FAKE_TELEMETRY_TOKEN }), e);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
  const raw = await r.text();
  assert.ok(!raw.includes(FAKE_KEY) && !raw.includes(FAKE_WHSEC) && !raw.includes(FAKE_PEPPER) && !raw.includes(FAKE_TELEMETRY_TOKEN));
  const t = JSON.parse(raw);
  for (const k of ["checkout_starts", "paid", "since", "day7_kill_rule", "stripe_mode", "by_mode"]) assert.ok(k in t, k);
  assert.equal(t.since, "2026-11-05T12:00:00.000Z");
  assert.equal(t.day7_kill_rule.min_checkout_starts, 10);
  assert.equal(t.day7_kill_rule.evaluate_at_utc, "2026-11-12T12:00:00.000Z");
  assert.equal(t.stripe_mode, "test");
  const unconfigured = await fullTelemetry(env({ STRIPE_SECRET_KEY: undefined }));
  assert.equal(unconfigured.day7_kill_rule.verdict, "clock_not_started");
  assert.equal(unconfigured.stripe_mode, "unconfigured");
  assert.equal(unconfigured.since, null);
  // no token configured => full view impossible
  const none = await (await worker.fetch(getReq("/api/rro/telemetry", { Authorization: "Bearer " }), env())).json();
  assert.ok(!("checkout_starts" in none));
});

// ---------------------------------------------------------------- T1 /rro page CTA states
test("T1: /rro hides the £24 CTA in test mode without preview, and when unconfigured", async () => {
  for (const e of [env(), {}, env({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY })]) {
    const r = await worker.fetch(getReq("/rro"), e);
    const html = await r.text();
    assert.doesNotMatch(html, /id="formalPackBtn"/);
    assert.doesNotMatch(html, /RRO_FORMAL_PACK_CTA/);
    assert.equal(r.headers.get("X-RRO-CTA"), "hidden");
  }
});

test("T1: /rro?rro_preview=<signed token> in test mode shows CTA with TEST MODE label and sets signed HttpOnly preview cookie", async () => {
  const link = await worker.fetch(getReq("/rro?rro_preview=" + PREVIEW_LINK_TOKEN), env(), { redirect: "manual" });
  // M3: the token is stripped by a 302 to /rro that carries the signed cookie and no-referrer.
  assert.equal(link.status, 302);
  assert.equal(link.headers.get("Location"), "/rro");
  assert.equal(link.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(link.headers.get("Cache-Control"), /no-store/);
  assert.equal(await link.text(), "");
  const setCookie = link.headers.get("Set-Cookie");
  const r = await worker.fetch(getReq("/rro", { Cookie: setCookie.split(";")[0] }), env());
  const html = await r.text();
  assert.equal(r.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(html, /id="formalPackBtn"/);
  assert.match(html, /\[TEST MODE\] Export Formal Tribunal Appeal Pack — £24/);
  assert.match(html, /TEST MODE – no real payment; do not enter real card details/);
  assert.equal(r.headers.get("X-RRO-CTA"), "test_preview");
  assert.match(setCookie, /^rro_preview=\d+\.[0-9a-f]{64};.*HttpOnly.*SameSite=Strict/);
  assert.match(r.headers.get("Cache-Control"), /no-store/);
  const viaCookie = await worker.fetch(getReq("/rro", PREVIEW), env());
  assert.match(await viaCookie.text(), /TEST MODE – no real payment/);
});

test("/rro in (gated) live mode has the plain £24 CTA, no TEST label; CSP allows Stripe Checkout form-action", async () => {
  const r = await worker.fetch(getReq("/rro"), env({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY, RRO_STRIPE_LIVE_ENABLED: "true" }));
  const html = await r.text();
  assert.match(html, /Export Formal Tribunal Appeal Pack — £24/);
  assert.doesNotMatch(html, /\[TEST MODE\]/);
  assert.match(html, /\/api\/rro\/checkout/);
  assert.doesNotMatch(html, /Dossier Pack \(£29\)/);
  assert.equal(r.headers.get("X-RRO-CTA"), "live");
  assert.match(r.headers.get("Content-Security-Policy"), /form-action 'self' https:\/\/checkout\.stripe\.com/);
});

test("T1: preview is HMAC-signed — unsigned/forged/expired/wrong-key cookies and links get no CTA and no test checkout", async () => {
  const e = env();
  for (const bad of ["/rro?rro_preview=1", "/rro?rro_preview=" + "0".repeat(64)]) {
    const r = await worker.fetch(getReq(bad), e);
    assert.equal(r.headers.get("X-RRO-CTA"), "hidden", bad);
    assert.equal(r.headers.get("Set-Cookie"), null, bad);
  }
  const past = Math.floor(Date.now() / 1000) - 10;
  for (const c of ["rro_preview=1", previewCookie(past), previewCookie(undefined, "another-preview-secret-xxxxxxxx")]) {
    const page = await worker.fetch(getReq("/rro", { Cookie: c }), e);
    assert.equal(page.headers.get("X-RRO-CTA"), "hidden", c);
    const r = await worker.fetch(checkoutReq({}, { Cookie: c }), env());
    assert.equal(r.status, 503, c);
  }
});

test("T1: missing RRO_PREVIEW_SECRET fails closed — even a well-formed cookie gives no CTA and no test checkout", async () => {
  const e = env({ RRO_PREVIEW_SECRET: undefined });
  const page = await worker.fetch(getReq("/rro?rro_preview=" + PREVIEW_LINK_TOKEN, PREVIEW), e);
  assert.equal(page.headers.get("X-RRO-CTA"), "hidden");
  const r = await worker.fetch(checkoutReq(), env({ RRO_PREVIEW_SECRET: undefined }));
  assert.equal(r.status, 503);
});

// ---------------------------------------------------------------- review round 3 (M1-M4, L1)
test("M1: paid cache and pack keep only the minimal session fields — never customer_details", async () => {
  const { rroPaidCacheProject } = await import("../src/rro_checkout.js");
  const pii = { customer_details: { email: "pii-test@example.invalid", name: "PII Person", phone: "+440000", address: { line1: "1 PII St" } }, customer_email: "pii-test@example.invalid" };
  const projected = rroPaidCacheProject(paidSession("cs_test_PROJECT0000000001", pii));
  assert.deepEqual(Object.keys(projected).sort(), ["amount_total", "created", "currency", "id", "livemode", "metadata", "object", "payment_status"]);
  const e = env();
  const session = paidSession("cs_test_PIICACHE000000001", pii);
  seedStart(e, session.id);
  mockStripe(() => jsonResp(session));
  const body = await (await worker.fetch(getReq("/api/rro/pack?session_id=" + session.id), e)).text();
  assert.doesNotMatch(body, /pii-test@example\.invalid|PII Person|1 PII St/);
  noStripe();
  const again = await worker.fetch(getReq("/api/rro/pack?session_id=" + session.id), e);
  assert.equal(again.status, 200);
  assert.doesNotMatch(await again.text(), /pii-test@example\.invalid|PII Person/);
});

test("M2: over-limit pack lookups are refused with no D1 write, and lookups never run the retention purge", async () => {
  noStripe();
  const e = env();
  const db = e.RRO_CHECKOUT_DB._db;
  seedStart(e, "cs_test_OLDPURGE000000001");
  db.prepare("UPDATE rro_checkout_events SET created_at_utc = ? WHERE session_id = ?").run(new Date(Date.now() - 49 * 3600000).toISOString(), "cs_test_OLDPURGE000000001");
  for (let i = 0; i < 30; i++) await worker.fetch(getReq("/api/rro/pack?session_id=cs_test_RLW" + String(i).padStart(17, "0")), e);
  const hits = () => db.prepare("SELECT COUNT(*) AS n FROM rro_rate_hits").get().n;
  assert.equal(hits(), 30);
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(getReq("/rro/pack/success?session_id=cs_test_RLWOVER00000000001"), e)).status, 429);
  assert.equal(hits(), 30, "over-limit requests must not insert");
  assert.equal(db.prepare("SELECT ip_hash FROM rro_checkout_events WHERE session_id = ?").get("cs_test_OLDPURGE000000001").ip_hash, "seed", "GET lookups must not purge");
  await worker.scheduled({}, e);
  assert.equal(db.prepare("SELECT ip_hash FROM rro_checkout_events WHERE session_id = ?").get("cs_test_OLDPURGE000000001").ip_hash, null);
});

test("M4: Stripe network error -> 502 JSON; oversize Content-Length -> 413 before read; unsupported type -> 415", async () => {
  mockStripe(() => { throw new TypeError("network down"); });
  const r = await worker.fetch(checkoutReq(), env());
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, "STRIPE_SESSION_CREATE_FAILED");
  noStripe();
  const big = await worker.fetch(checkoutReq({}, { "Content-Length": "5000" }), env());
  assert.equal(big.status, 413);
  const bigBody = await worker.fetch(checkoutReq({ pad: "x".repeat(5000) }), env());
  assert.equal(bigBody.status, 413);
  const plain = await worker.fetch(checkoutReq({}, { "Content-Type": "text/plain" }), env());
  assert.equal(plain.status, 415);
  assert.equal(stripeCalls.length, 0);
});

test("L1: webhook rejects livemode that mismatches the configured mode or the session id prefix", async () => {
  const e = env();
  const liveEvent = { type: "checkout.session.completed", data: { object: paidSession("cs_live_LIVEINTEST00000001", { livemode: true }) } };
  assert.equal((await worker.fetch(webhookReq(liveEvent), e)).status, 400);
  const forged = { type: "checkout.session.completed", data: { object: paidSession("cs_live_PREFIXLIE00000001", { livemode: false }) } };
  assert.equal((await worker.fetch(webhookReq(forged), e)).status, 400);
  const ok = { type: "checkout.session.completed", data: { object: paidSession("cs_test_MODEOK0000000001") } };
  assert.equal((await (await worker.fetch(webhookReq(ok), e)).json()).recorded, true);
  assert.equal((await fullTelemetry(e)).paid, 1);
});

test("M-R1: over-limit checkout is refused before the retention purge or any data write", async () => {
  noStripe();
  const e = env();
  const db = e.RRO_CHECKOUT_DB._db;
  await worker.fetch(checkoutReq({}, { Cookie: "" }), e); // preview-less: 503, nothing written
  db.exec("CREATE TABLE IF NOT EXISTS rro_rate_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, ip_hash TEXT NOT NULL, created_at_utc TEXT NOT NULL)");
  // Fill the window for this IP by replaying allowed starts with Stripe failing (slots still count).
  mockStripe(() => jsonResp({}, 500));
  for (let i = 0; i < 5; i++) await worker.fetch(checkoutReq(), e);
  seedStart(e, "cs_test_PURGEPROBE00000001");
  db.prepare("UPDATE rro_checkout_events SET created_at_utc = ? WHERE session_id = ?").run(new Date(Date.now() - 49 * 3600000).toISOString(), "cs_test_PURGEPROBE00000001");
  const hits = () => db.prepare("SELECT COUNT(*) AS n FROM rro_rate_hits").get().n;
  const before = hits();
  noStripe();
  const r = await worker.fetch(checkoutReq(), e);
  assert.equal(r.status, 429);
  assert.equal(hits(), before, "a refused caller writes no rate-limit row");
  assert.equal(db.prepare("SELECT ip_hash FROM rro_checkout_events WHERE session_id = ?").get("cs_test_PURGEPROBE00000001").ip_hash, "seed", "a refused caller does not trigger the purge");
});

test("L-R2: rate limit check-and-insert is one atomic statement (concurrent callers cannot exceed max)", async () => {
  let n = 0;
  mockStripe(() => { n++; return jsonResp({ id: "cs_test_CONC" + String(n).padStart(12, "0"), url: "https://checkout.stripe.com/c/pay/c" + n }); });
  const e = env();
  const seen = [];
  const realPrepare = e.RRO_CHECKOUT_DB.prepare;
  e.RRO_CHECKOUT_DB.prepare = (sql) => { if (/rro_rate_hits/.test(sql)) seen.push(sql); return realPrepare(sql); };
  const results = await Promise.all(Array.from({ length: 8 }, () => worker.fetch(checkoutReq(), e)));
  const ok = results.filter((r) => r.status === 200).length;
  assert.equal(ok, 5, "exactly max_starts (5) admitted, got " + ok);
  assert.ok(results.some((r) => r.status === 429));
  const limiterSql = seen.filter((s) => /^INSERT INTO rro_rate_hits/.test(s));
  assert.ok(limiterSql.length > 0 && limiterSql.every((s) => /SELECT[\s\S]*WHERE \(SELECT COUNT\(\*\)/.test(s)), "limiter must be a single conditional INSERT ... SELECT");
  assert.ok(!seen.some((s) => /^SELECT COUNT\(\*\) AS n FROM rro_rate_hits/.test(s)), "no separate read-then-write");
});

test("L-R3: telemetry bearer is compared as SHA-256 digests (length-independent); wrong/longer/shorter tokens refused", async () => {
  const e = { ...env(), RRO_TELEMETRY_TOKEN: FAKE_TELEMETRY_TOKEN };
  const call = (tok) => worker.fetch(getReq("/api/rro/telemetry", { Authorization: "Bearer " + tok }), e).then((r) => r.json());
  const good = await call(FAKE_TELEMETRY_TOKEN);
  const pub = await call("x");
  assert.notDeepEqual(good, pub);
  for (const t of [FAKE_TELEMETRY_TOKEN + "0", FAKE_TELEMETRY_TOKEN.slice(0, -1), "y".repeat(FAKE_TELEMETRY_TOKEN.length)]) {
    assert.deepEqual(await call(t), pub);
  }
  const src = (await import("node:fs")).readFileSync(new URL("../src/rro_checkout.js", import.meta.url), "utf8");
  assert.match(src, /rroTimingSafeEqualHex\(given, expected\)/);
});

test("L-R4: /rro is always private, no-store with Vary: Cookie (hidden, preview and live variants)", async () => {
  for (const [e, h] of [[env(), {}], [env(), PREVIEW], [env({ STRIPE_SECRET_KEY: FAKE_LIVE_KEY, RRO_STRIPE_LIVE_ENABLED: "true" }), {}]]) {
    const r = await worker.fetch(getReq("/rro", h), e);
    assert.equal(r.headers.get("Cache-Control"), "private, no-store");
    assert.match(r.headers.get("Vary") || "", /Cookie/);
  }
});
