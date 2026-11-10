// node --test tests/  — P1 body caps on POST /api/rro-search and /api/rro-calculate; P5 secret trimming.
// No network: globalThis.fetch is a recorder that throws.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker.js";
import { rroResetIsolateStateForTests, rroStripeMode, rroStripeSecretKey, rroWebhookSecret, rroStripeRequest, rroIpPepper } from "../src/rro_core.js";

const ORIGIN = "https://parish.technoplusit.co.uk";
const CAP = 16 * 1024;
const FAKE_KEY = "sk_test_" + "FAKEFAKEFAKE0123456789";
const FAKE_WHSEC = "whsec_" + "unit_test_only_not_a_real_secret";
const FAKE_PEPPER = "unit-test-pepper-" + "not-a-real-secret-000";

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
const env = (over = {}) => { rroResetIsolateStateForTests(); return { RRO_IP_PEPPER: FAKE_PEPPER, RRO_CHECKOUT_DB: fakeD1(), ...over }; };
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); throw new Error("unexpected network call"); };

const PATHS = ["/api/rro-search", "/api/rro-calculate"];
const NORMAL = {
  "/api/rro-search": { region: "London", offence_type: "Unlicensed HMO (s.72)", limit: 5 },
  "/api/rro-calculate": { monthly_rent_gbp: 1800, months_unlicensed: 12, universal_credit_housing_gbp: 0, utilities_included_monthly_gbp: 150, region: "London", offence_type: "Unlicensed HMO (s.72)", party_role: "landlord_defence", mitigation_factors: "first offence, licence applied for, good conduct", format: "json" },
};

// A body stream that counts how many bytes the Worker actually pulled, with no Content-Length (chunked).
function chunkedBody(totalBytes, chunk = 4096) {
  let sent = 0;
  const stats = { pulled: 0 };
  const stream = new ReadableStream({
    pull(ctrl) {
      if (sent >= totalBytes) return ctrl.close();
      const n = Math.min(chunk, totalBytes - sent);
      sent += n;
      stats.pulled = sent;
      ctrl.enqueue(new Uint8Array(n).fill(0x20));
    },
  });
  return { stream, stats };
}
const post = (path, body, headers = {}) =>
  new Request(ORIGIN + path, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7", ...headers }, body, duplex: "half" });

async function assert413(r) {
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { status: "error", error: "PAYLOAD_TOO_LARGE", max_bytes: CAP });
  assert.equal(r.headers.get("Cache-Control"), "no-store");
}

for (const path of PATHS) {
  test("P1 " + path + ": normal POST body succeeds (200) and is well under the cap", async () => {
    const body = JSON.stringify(NORMAL[path]);
    assert.ok(Buffer.byteLength(body) < 1024, "realistic payload is < 1 KB: " + Buffer.byteLength(body));
    const r = await worker.fetch(post(path, body), env());
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.status === "error", false);
  });

  test("P1 " + path + ": a body of exactly the cap is accepted", async () => {
    const pad = " ".repeat(CAP - JSON.stringify(NORMAL[path]).length);
    const body = JSON.stringify(NORMAL[path]) + pad;
    assert.equal(Buffer.byteLength(body), CAP);
    assert.equal((await worker.fetch(post(path, body), env())).status, 200);
  });

  test("P1 " + path + ": oversize declared Content-Length -> 413 before reading the body", async () => {
    const { stream, stats } = chunkedBody(8 * 1024 * 1024);
    const r = await worker.fetch(post(path, stream, { "Content-Length": String(8 * 1024 * 1024) }), env());
    await assert413(r);
    assert.equal(stats.pulled <= 64 * 1024, true, "pulled " + stats.pulled); // at most the stream's own read-ahead
  });

  test("P1 " + path + ": oversize real body with Content-Length (8 MiB) -> 413", async () => {
    const big = JSON.stringify({ q: "x".repeat(8 * 1024 * 1024) });
    await assert413(await worker.fetch(post(path, big), env()));
  });

  test("P1 " + path + ": oversize chunked body (no Content-Length) -> 413 and reading stops just past the cap", async () => {
    const { stream, stats } = chunkedBody(8 * 1024 * 1024);
    const req = post(path, stream);
    assert.equal(req.headers.get("Content-Length"), null);
    await assert413(await worker.fetch(req, env()));
    assert.ok(stats.pulled <= CAP + 3 * 4096, "pulled " + stats.pulled + " bytes of 8 MiB");
  });

  test("P1 " + path + ": a lying small Content-Length does not bypass the streamed count", async () => {
    const { stream } = chunkedBody(CAP + 1);
    await assert413(await worker.fetch(post(path, stream, { "Content-Length": "10" }), env()));
  });
}

test("P1: GET forms of search and calculate are unaffected (200)", async () => {
  for (const p of ["/api/rro-search?region=London", "/api/rro-calculate?monthly_rent_gbp=1800&months_unlicensed=12&region=London"]) {
    assert.equal((await worker.fetch(new Request(ORIGIN + p), env())).status, 200, p);
  }
});

const WS = [" ", "\n", "\r\n", "\t", " \n "];
test("P5: sk_test_ with leading/trailing whitespace or newline is trimmed, then accepted as test mode", () => {
  for (const w of WS) {
    for (const v of [w + FAKE_KEY, FAKE_KEY + w, w + FAKE_KEY + w]) {
      assert.deepEqual(rroStripeMode({ STRIPE_SECRET_KEY: v }), { ok: true, mode: "test" }, JSON.stringify(w));
      assert.equal(rroStripeSecretKey({ STRIPE_SECRET_KEY: v }), FAKE_KEY);
    }
  }
});

test("P5: whsec_ with leading/trailing whitespace or newline is trimmed before the shape check", () => {
  for (const w of WS) {
    for (const v of [w + FAKE_WHSEC, FAKE_WHSEC + w, w + FAKE_WHSEC + w]) assert.equal(rroWebhookSecret({ STRIPE_WEBHOOK_SECRET: v }), FAKE_WHSEC);
  }
});

test("P5: trimming does not loosen the shape checks (inner whitespace, live keys, short/blank values)", () => {
  assert.equal(rroWebhookSecret({ STRIPE_WEBHOOK_SECRET: "whsec_ " + "unit_test_only_not_a_real_secret" }), null);
  assert.equal(rroWebhookSecret({ STRIPE_WEBHOOK_SECRET: "  \n " }), null);
  assert.equal(rroWebhookSecret({ STRIPE_WEBHOOK_SECRET: " whsec_short\n" }), null);
  assert.equal(rroStripeMode({ STRIPE_SECRET_KEY: "sk_test_ FAKE0123" }).ok, false);
  assert.equal(rroStripeMode({ STRIPE_SECRET_KEY: " \n" }).ok, false);
  // A trimmed live key is still blocked without the exact flag, and the flag itself is NOT trimmed.
  const live = "sk_live_" + "FAKE0123456789";
  assert.equal(rroStripeMode({ STRIPE_SECRET_KEY: live + "\n" }).mode, "live_blocked");
  assert.equal(rroStripeMode({ STRIPE_SECRET_KEY: live + "\n", RRO_STRIPE_LIVE_ENABLED: "true\n" }).ok, false);
  assert.equal(rroStripeMode({ STRIPE_SECRET_KEY: live + "\n", RRO_STRIPE_LIVE_ENABLED: " true" }).ok, false);
});

test("P5: the trimmed key (no newline) is the one sent to Stripe", async () => {
  calls.length = 0;
  await rroStripeRequest({ STRIPE_SECRET_KEY: FAKE_KEY + "\n" }, "GET", "/v1/checkout/sessions/cs_test_x").catch(() => {});
  assert.equal(calls.length, 1);
  const auth = calls[0].init.headers.Authorization;
  assert.equal(auth, "Bearer " + FAKE_KEY);
  calls.length = 0;
});

test("P5: with newline-padded test secrets /rro is configured (telemetry mode 'test'), and pepper==trimmed whsec is still refused", async () => {
  const e = env({ STRIPE_SECRET_KEY: FAKE_KEY + "\n", STRIPE_WEBHOOK_SECRET: FAKE_WHSEC + "\n" });
  const t = await (await worker.fetch(new Request(ORIGIN + "/api/rro/telemetry"), e)).json();
  assert.equal(t.mode, "test");
  assert.equal(rroIpPepper({ RRO_IP_PEPPER: FAKE_WHSEC, STRIPE_WEBHOOK_SECRET: FAKE_WHSEC + "\n" }), null);
});
