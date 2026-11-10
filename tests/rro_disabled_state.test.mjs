// node --test tests/  — £24 RRO checkout gracefully disabled when the Stripe env is missing or malformed.
// No network: globalThis.fetch is replaced by a recorder that fails the test on any call.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import worker from "../worker.js";
import { rroResetIsolateStateForTests, rroWebhookSecret, RRO_CHECKOUT_SCHEMA } from "../src/rro_core.js";

const ORIGIN = "https://parish.technoplusit.co.uk";
const FAKE_PEPPER = "unit-test-pepper-" + "not-a-real-secret-000";
const FAKE_PREVIEW_SECRET = "unit-test-preview-" + "secret-not-real-000000";
const exp = Math.floor(Date.now() / 1000) + 3600;
const PREVIEW = { Cookie: "rro_preview=" + exp + "." + crypto.createHmac("sha256", FAKE_PREVIEW_SECRET).update("rro-preview-cookie-v1:" + exp).digest("hex") };

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (s) => Promise.all(s.map((x) => x.run())), _db: db };
}

// Production today: pepper + telemetry token set, no Stripe secrets at all.
function noStripeEnv(over = {}) {
  rroResetIsolateStateForTests();
  return { RRO_IP_PEPPER: FAKE_PEPPER, RRO_PREVIEW_SECRET: FAKE_PREVIEW_SECRET, RRO_CHECKOUT_DB: fakeD1(), ...over };
}

const calls = [];
function trapFetch() {
  calls.length = 0;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("unexpected network call");
  };
}
const stripeCalls = () => calls.filter((u) => /stripe\.com/i.test(u));
const get = (path, headers = {}) => new Request(ORIGIN + path, { headers: { "CF-Connecting-IP": "203.0.113.7", ...headers } });

// Malformed / missing configurations that must all leave checkout disabled.
const DISABLED = [
  ["no Stripe env at all", {}],
  ["webhook secret only", { STRIPE_WEBHOOK_SECRET: "whsec_" + "unit_test_only_not_a_real_secret" }],
  ["secret key only", { STRIPE_SECRET_KEY: "sk_test_" + "FAKEFAKEFAKE0123456789" }],
  ["secret key not sk_test_-shaped", { STRIPE_SECRET_KEY: "pk_test_" + "FAKEFAKE0123", STRIPE_WEBHOOK_SECRET: "whsec_" + "unit_test_only_not_a_real_secret" }],
  ["webhook secret not whsec_-shaped", { STRIPE_SECRET_KEY: "sk_test_" + "FAKEFAKEFAKE0123456789", STRIPE_WEBHOOK_SECRET: "not-a-whsec-value-0000000000" }],
  ["webhook secret too short", { STRIPE_SECRET_KEY: "sk_test_" + "FAKEFAKEFAKE0123456789", STRIPE_WEBHOOK_SECRET: "whsec_" + "x" }],
  ["live key without RRO_STRIPE_LIVE_ENABLED", { STRIPE_SECRET_KEY: "sk_live_" + "FAKE0123456789", STRIPE_WEBHOOK_SECRET: "whsec_" + "unit_test_only_not_a_real_secret" }],
  ["live key with a non-exact flag", { STRIPE_SECRET_KEY: "sk_live_" + "FAKE0123456789", STRIPE_WEBHOOK_SECRET: "whsec_" + "unit_test_only_not_a_real_secret", RRO_STRIPE_LIVE_ENABLED: "TRUE" }],
];

for (const [label, over] of DISABLED) {
  test("disabled (" + label + "): /rro shows £24 'cannot be purchased today' note, no CTA, no £29, no Stripe link, no fetch", async () => {
    trapFetch();
    for (const headers of [{}, PREVIEW]) {
      const r = await worker.fetch(get("/rro", headers), noStripeEnv(over));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("X-RRO-CTA"), "hidden");
      const html = await r.text();
      assert.match(html, /id="formalPackComingSoon"[^>]*>Optional Export Formal Tribunal Appeal Pack \(£24\):[^<]*Checkout is not enabled on this page yet, so this pack cannot be purchased today\./);
      assert.doesNotMatch(html, /id="formalPackBtn"/);
      assert.doesNotMatch(html, /£29|rro-buy-pack|rro\/buy-pack/);
      // No link or form out to Stripe (the inline script only has an allow-list check for a returned URL).
      assert.doesNotMatch(html, /(href|action|src)\s*=\s*["']?[^"'>]*stripe\.com/i);
      assert.doesNotMatch(html, /buy\.stripe\.com/);
    }
    assert.deepEqual(stripeCalls(), []);
  });

  test("disabled (" + label + "): POST /api/rro/checkout -> 503 CHECKOUT_NOT_CONFIGURED, no Stripe call, no D1 write", async () => {
    trapFetch();
    const e = noStripeEnv(over);
    const r = await worker.fetch(new Request(ORIGIN + "/api/rro/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.7", ...PREVIEW },
      body: JSON.stringify({ region: "London", monthly_rent_gbp: 1800, months_unlicensed: 12 }),
    }), e);
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.deepEqual(body, { status: "error", error: "CHECKOUT_NOT_CONFIGURED" });
    assert.equal(r.headers.get("Location"), null);
    assert.deepEqual(stripeCalls(), []);
    const t = e.RRO_CHECKOUT_DB._db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='rro_checkout_events'").get().n;
    if (t) assert.equal(e.RRO_CHECKOUT_DB._db.prepare("SELECT COUNT(*) AS n FROM rro_checkout_events").get().n, 0);
  });

  test("disabled (" + label + "): webhook -> safe 503 WEBHOOK_NOT_CONFIGURED, no Stripe call", async () => {
    trapFetch();
    const r = await worker.fetch(new Request(ORIGIN + "/api/rro/stripe-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=00" },
      body: JSON.stringify({ type: "checkout.session.completed", data: { object: {} } }),
    }), noStripeEnv(over));
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { status: "error", error: "WEBHOOK_NOT_CONFIGURED" });
    assert.deepEqual(stripeCalls(), []);
  });
}

test("disabled: public telemetry reports mode 'unavailable' and the £24 price; pack lookups 503 with no Stripe call", async () => {
  trapFetch();
  const t = await (await worker.fetch(get("/api/rro/telemetry"), noStripeEnv())).json();
  assert.equal(t.mode, "unavailable");
  assert.equal(t.price_gbp, 24);
  for (const p of ["/rro/pack/success?session_id=cs_test_a1B2c3D4e5F6g7H8i9J0", "/api/rro/pack?session_id=cs_test_a1B2c3D4e5F6g7H8i9J0"]) {
    const r = await worker.fetch(get(p), noStripeEnv());
    assert.equal(r.status, 503, p);
  }
  assert.deepEqual(stripeCalls(), []);
});

test("disabled: a usable sk_test_ key but missing/malformed whsec -> pack lookups 503 with no Stripe call, even for a known session", async () => {
  for (const wh of [undefined, "not-a-whsec-value-0000000000"]) {
    trapFetch();
    const e = noStripeEnv({ STRIPE_SECRET_KEY: "sk_test_" + "FAKEFAKEFAKE0123456789", STRIPE_WEBHOOK_SECRET: wh });
    const sid = "cs_test_a1B2c3D4e5F6g7H8i9J0";
    for (const sql of RRO_CHECKOUT_SCHEMA) e.RRO_CHECKOUT_DB._db.exec(sql);
    e.RRO_CHECKOUT_DB._db.prepare("INSERT INTO rro_checkout_events (kind, stripe_mode, session_id, created_at_utc) VALUES ('checkout_start','test',?,?)").run(sid, new Date().toISOString());
    for (const p of ["/rro/pack/success?session_id=" + sid, "/api/rro/pack?session_id=" + sid]) {
      assert.equal((await worker.fetch(get(p), e)).status, 503, p);
    }
    assert.deepEqual(stripeCalls(), []);
  }
});

test("L9: the legacy £29 intent-test offer is gone (all three paths 404, no £29 body)", async () => {
  trapFetch();
  for (const p of ["/api/rro-buy-pack?region=London", "/api/rro/buy-pack?region=London", "/api/rro/buy-pack/"]) {
    const r = await worker.fetch(get(p), noStripeEnv());
    assert.equal(r.status, 404, p);
    const txt = await r.text();
    assert.doesNotMatch(txt, /price_gbp"?\s*:\s*29|intent_validation/);
  }
  assert.doesNotMatch(readFileSync(new URL("../worker.js", import.meta.url), "utf8"), /intent_validation_smoke_test|price_gbp: 29/);
  assert.deepEqual(stripeCalls(), []);
});

test("rroWebhookSecret only accepts whsec_-shaped values from env", () => {
  assert.equal(rroWebhookSecret({}), null);
  assert.equal(rroWebhookSecret({ STRIPE_WEBHOOK_SECRET: "" }), null);
  assert.equal(rroWebhookSecret({ STRIPE_WEBHOOK_SECRET: "whsec_short" }), null);
  assert.equal(rroWebhookSecret({ STRIPE_WEBHOOK_SECRET: "sk_test_" + "FAKEFAKEFAKE0123456789" }), null);
  const ok = "whsec_" + "unit_test_only_not_a_real_secret";
  // P5: surrounding whitespace is trimmed before the shape check (see tests/rro_body_caps_trim.test.mjs).
  assert.equal(rroWebhookSecret({ STRIPE_WEBHOOK_SECRET: " " + ok }), ok);
  assert.equal(rroWebhookSecret({ STRIPE_WEBHOOK_SECRET: "whsec_ " + "unit_test_only_not_a_real_secret" }), null);
  assert.equal(rroWebhookSecret({ STRIPE_WEBHOOK_SECRET: ok }), ok);
});

test("TC2: rro_rate_hits(created_at_utc) index in the migration and lazy schema, and the purge uses it", () => {
  const mig = readFileSync(new URL("../migrations/0002_rro_rate_hits_created_at.sql", import.meta.url), "utf8");
  assert.match(mig, /CREATE INDEX IF NOT EXISTS ix_rro_rate_hits_created_at ON rro_rate_hits\(created_at_utc\)/);
  assert.ok(RRO_CHECKOUT_SCHEMA.some((s) => /ix_rro_rate_hits_created_at ON rro_rate_hits\(created_at_utc\)/.test(s)));
  const db = new DatabaseSync(":memory:");
  for (const s of RRO_CHECKOUT_SCHEMA) db.exec(s);
  const plan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM rro_rate_hits WHERE created_at_utc < ?1").all("2026-01-01T00:00:00Z").map((r) => r.detail).join(" | ");
  assert.match(plan, /USING (COVERING )?INDEX ix_rro_rate_hits_created_at/, plan);
  const bounded = db.prepare("EXPLAIN QUERY PLAN DELETE FROM rro_rate_hits WHERE id IN (SELECT id FROM rro_rate_hits WHERE created_at_utc < ?1 LIMIT ?2)").all("2026-01-01T00:00:00Z", 500).map((r) => r.detail).join(" | ");
  assert.match(bounded, /INDEX ix_rro_rate_hits_created_at/, bounded);
});

test("TC1: the deploy build still registers and verifies the mandatory hourly cron", async () => {
  const { RETENTION_CRON } = await import("../deploy/build_cf_execute.mjs");
  assert.equal(RETENTION_CRON, "0 * * * *");
  const src = readFileSync(new URL("../deploy/build_cf_execute.mjs", import.meta.url), "utf8");
  assert.match(src, /retention cron .* is not registered/);
  assert.equal(typeof worker.scheduled, "function");
});
