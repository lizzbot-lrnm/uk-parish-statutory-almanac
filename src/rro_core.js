// ---------------------------------------------------------------------------
// Stripe Checkout: "Export Formal Tribunal Appeal Pack" (£24)
// Hosted Checkout Session redirect only.
//
// Day-7 falsification rule (full telemetry only):
//   clock starts at RRO_CHECKOUT_LIVE_SINCE (set when live-mode keys go on);
//   at +7 days, if checkout_starts < 10 OR paid == 0  ->  KILL the product.
//
// Env (names only — values are Worker secrets, never committed):
//   STRIPE_SECRET_KEY        secret  sk_test_… (sk_live_… refused unless RRO_STRIPE_LIVE_ENABLED=true)
//   STRIPE_WEBHOOK_SECRET    secret  whsec_… for /api/rro/stripe-webhook
//   RRO_STRIPE_LIVE_ENABLED  var     "true" only after the live-mode security review and owner approval
//   RRO_CHECKOUT_LIVE_SINCE  var     ISO-8601 UTC timestamp the Day-7 clock starts
//   RRO_CHECKOUT_DB          D1      checkout_start / paid event rows + rate-limit hits
//   RRO_IP_PEPPER            secret  dedicated HMAC pepper for ip_hash (NOT the whsec); fail closed if missing
//   RRO_TELEMETRY_TOKEN      secret  optional bearer for full /api/rro/telemetry (public view is minimal)
//   RRO_PREVIEW_SECRET       secret  HMAC key for the test-mode preview link + cookie; fail closed if missing
//
// Test-mode conditions implemented here: T1 (test-mode CTA preview gate + label),
// T2 (D1-first lookup, paid-verdict cache, per-ip_hash limit), T3 (peppered HMAC ip_hash + 48h purge),
// T4 (exact "true" live flag), T5 (minimal public telemetry, generic checkout errors).
// TODO(live-gate L1–L11): see deploy/RRO_STRIPE_CHECKOUT.md "Live gate checklist". NOT in this pass.
// ---------------------------------------------------------------------------
const RRO_PACK_PRODUCT_KEY = "tribunal_appeal_pack";
const RRO_PACK_PRODUCT_NAME = "Export Formal Tribunal Appeal Pack";
const RRO_PACK_PRICE_PENCE = 2400;
const RRO_PACK_CURRENCY = "gbp";
const RRO_PUBLIC_ORIGIN = "https://parish.technoplusit.co.uk";
const RRO_CHECKOUT_RATE_LIMIT = { max_starts: 5, window_minutes: 10 };
const RRO_LOOKUP_RATE_LIMIT = { max_hits: 30, window_minutes: 10 };
const RRO_PAID_CACHE_TTL_MS = 10 * 60 * 1000;
const RRO_IP_HASH_RETENTION_HOURS = 48;
const RRO_PREVIEW_COOKIE = "rro_preview";
const RRO_TEST_MODE_LABEL = "TEST MODE – no real payment; do not enter real card details";
const RRO_PACK_DOWNLOAD_DAYS = 30;
const RRO_DAY7_RULE = Object.freeze({
  window_days: 7,
  min_checkout_starts: 10,
  min_paid: 1,
  rule: "At day 7 after RRO_CHECKOUT_LIVE_SINCE: checkout_starts < 10 OR paid == 0 -> kill the £24 Formal Tribunal Appeal Pack",
});
const RRO_SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{10,240}$/;
const RRO_CHECKOUT_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS rro_checkout_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('checkout_start','paid')), stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('test','live')), session_id TEXT, ip_hash TEXT, amount_total INTEGER, currency TEXT, created_at_utc TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_rro_checkout_kind_session ON rro_checkout_events(kind, session_id)",
  "CREATE INDEX IF NOT EXISTS ix_rro_checkout_kind_mode_time ON rro_checkout_events(kind, stripe_mode, created_at_utc)",
  "CREATE INDEX IF NOT EXISTS ix_rro_checkout_ip_time ON rro_checkout_events(ip_hash, created_at_utc)",
  "CREATE TABLE IF NOT EXISTS rro_rate_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, ip_hash TEXT NOT NULL, created_at_utc TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ix_rro_rate_hits ON rro_rate_hits(bucket, ip_hash, created_at_utc)",
];
// One DDL batch per isolate: a module-level promise (a D1 binding wrapper is not a stable WeakSet key).
// A failed batch clears the promise so the next request retries.
let RRO_CHECKOUT_SCHEMA_PROMISE = null;
// caches.default keys live under one namespaced internal prefix that no public route serves.
const RRO_INTERNAL_CACHE_PREFIX = "https://parish.technoplusit.co.uk/__rro_internal_cache/v1/";
const RRO_OPPORTUNISTIC_PURGE_LIMIT = 500;

function rroStripeMode(env) {
  const key = String((env && env.STRIPE_SECRET_KEY) || "");
  if (!key) return { ok: false, mode: "unconfigured", reason: "STRIPE_SECRET_KEY_MISSING" };
  if (/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) return { ok: true, mode: "test" };
  if (/^(sk|rk)_live_[A-Za-z0-9]+$/.test(key)) {
    // T4 / W-L1: exact, case-sensitive match only ("TRUE", " true", "1" all stay blocked).
    if (env.RRO_STRIPE_LIVE_ENABLED === "true") return { ok: true, mode: "live" };
    return { ok: false, mode: "live_blocked", reason: "LIVE_KEY_PRESENT_BUT_RRO_STRIPE_LIVE_ENABLED_NOT_TRUE" };
  }
  return { ok: false, mode: "unconfigured", reason: "STRIPE_SECRET_KEY_UNRECOGNISED_PREFIX" };
}

function rroEnsureCheckoutSchema(db) {
  if (!RRO_CHECKOUT_SCHEMA_PROMISE) {
    RRO_CHECKOUT_SCHEMA_PROMISE = Promise.resolve()
      .then(() => db.batch(RRO_CHECKOUT_SCHEMA.map((sql) => db.prepare(sql))))
      .then(() => undefined)
      .catch((err) => {
        RRO_CHECKOUT_SCHEMA_PROMISE = null;
        throw err;
      });
  }
  return RRO_CHECKOUT_SCHEMA_PROMISE;
}

// Per-isolate fixed-window counters for read-only lookups. No D1 writes: the count lives in this
// isolate's Map and in caches.default (per colo) under the internal prefix; the higher of the two wins.
// Not globally exact across isolates/colos by design. It bounds Stripe lookups, not storage.
const RRO_LOOKUP_LIMITER = new Map();
const RRO_LOOKUP_LIMITER_MAX_KEYS = 5000;
// Per-key in-flight chain: checks for one key run one after another inside an isolate, and the count is
// re-read after the cache await, so concurrent requests cannot all pass on the same pre-await count.
const RRO_LOOKUP_INFLIGHT = new Map();
function rroCacheRateLimitHit(bucket, ipHash, max, windowMinutes, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const windowMs = windowMinutes * 60000;
  const windowIdx = Math.floor(now / windowMs);
  const key = RRO_INTERNAL_CACHE_PREFIX + "rl/" + encodeURIComponent(bucket) + "/" + encodeURIComponent(ipHash) + "/" + windowIdx;
  const prev = RRO_LOOKUP_INFLIGHT.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => rroCacheRateLimitStep(key, max, windowIdx, windowMs, now));
  RRO_LOOKUP_INFLIGHT.set(key, run);
  run.finally(() => { if (RRO_LOOKUP_INFLIGHT.get(key) === run) RRO_LOOKUP_INFLIGHT.delete(key); }).catch(() => {});
  return run;
}

async function rroCacheRateLimitStep(key, max, windowIdx, windowMs, now) {
  for (const [k, v] of RRO_LOOKUP_LIMITER) {
    if (v.exp > now && RRO_LOOKUP_LIMITER.size < RRO_LOOKUP_LIMITER_MAX_KEYS) break;
    RRO_LOOKUP_LIMITER.delete(k);
  }
  const cache = typeof caches !== "undefined" && caches && caches.default ? caches.default : null;
  let shared = 0;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) shared = Number(await hit.text()) || 0;
    } catch (_) {}
  }
  // Re-read the isolate counter after the await.
  const local = RRO_LOOKUP_LIMITER.get(key);
  const count = Math.max(local && local.exp > now ? local.n : 0, shared);
  if (count >= max) return false;
  const exp = (windowIdx + 1) * windowMs;
  RRO_LOOKUP_LIMITER.set(key, { n: count + 1, exp });
  if (cache) {
    try {
      const ttl = Math.max(1, Math.ceil((exp - now) / 1000));
      await cache.put(key, new Response(String(count + 1), { headers: { "Cache-Control": "max-age=" + ttl } }));
    } catch (_) {}
  }
  return true;
}

// Bounded body read: refuses a declared Content-Length over maxBytes, then streams the body and cancels
// as soon as the running total passes maxBytes, so chunked or header-less requests are bounded too.
async function rroReadCappedBody(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false };
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (_) {}
      return { ok: false };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) { buf.set(ch, off); off += ch.byteLength; }
  return { ok: true, text: new TextDecoder().decode(buf) };
}

// Test hook: forget per-isolate state (schema promise, lookup counters) between in-process test cases.
function rroResetIsolateStateForTests() {
  RRO_CHECKOUT_SCHEMA_PROMISE = null;
  RRO_LOOKUP_LIMITER.clear();
  RRO_LOOKUP_INFLIGHT.clear();
}

function rroJson(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...(extraHeaders || {}),
    },
  });
}

// T3 / W-M2: HMAC-SHA256(RRO_IP_PEPPER, day + ":" + ip). Dedicated secret, never the whsec.
// Returns null when the pepper is missing/too short so callers fail closed (no unkeyed fallback).
function rroIpPepper(env) {
  const pepper = typeof (env && env.RRO_IP_PEPPER) === "string" ? env.RRO_IP_PEPPER : "";
  if (pepper.length < 16) return null;
  if (env.STRIPE_WEBHOOK_SECRET && pepper === env.STRIPE_WEBHOOK_SECRET) return null;
  return pepper;
}

async function rroIpHash(request, env) {
  const pepper = rroIpPepper(env);
  if (!pepper) return null;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  return (await rroHmacSha256Hex(pepper, day + ":" + ip)).slice(0, 32);
}

// T3: retention. ip_hash on event rows is NULLed after 48h; rate-limit hits are deleted after 1h
// (they are only needed for the 10-minute windows). Runs from the mandatory hourly scheduled() cron and on
// admitted checkout writes; the webhook path runs the bounded variant below.
async function rroPurgeIpHashes(db, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const eventCutoff = new Date(now - RRO_IP_HASH_RETENTION_HOURS * 3600000).toISOString();
  const hitCutoff = new Date(now - 3600000).toISOString();
  await db.prepare("UPDATE rro_checkout_events SET ip_hash = NULL WHERE ip_hash IS NOT NULL AND created_at_utc < ?1").bind(eventCutoff).run();
  await db.prepare("DELETE FROM rro_rate_hits WHERE created_at_utc < ?1").bind(hitCutoff).run();
}

// Opportunistic retention on the webhook write path: at most `limit` rows per table per call.
async function rroPurgeIpHashesBounded(db, limit, nowMs) {
  const n = Math.max(1, Math.min(Number(limit) || RRO_OPPORTUNISTIC_PURGE_LIMIT, RRO_OPPORTUNISTIC_PURGE_LIMIT));
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const eventCutoff = new Date(now - RRO_IP_HASH_RETENTION_HOURS * 3600000).toISOString();
  const hitCutoff = new Date(now - 3600000).toISOString();
  await db
    .prepare("UPDATE rro_checkout_events SET ip_hash = NULL WHERE id IN (SELECT id FROM rro_checkout_events WHERE ip_hash IS NOT NULL AND created_at_utc < ?1 LIMIT ?2)")
    .bind(eventCutoff, n)
    .run();
  await db.prepare("DELETE FROM rro_rate_hits WHERE id IN (SELECT id FROM rro_rate_hits WHERE created_at_utc < ?1 LIMIT ?2)").bind(hitCutoff, n).run();
}

// Atomic check-and-reserve limiter: ONE conditional INSERT ... SELECT ... WHERE count < max, so two
// concurrent requests cannot both pass on the same stale count (no read-then-write TOCTOU). An
// over-limit caller inserts zero rows, so a flood cannot extend its own lockout or amplify D1 writes.
// An allowed caller's slot is written BEFORE any Stripe call, so failures still count.
async function rroRateLimitHit(db, bucket, ipHash, max, windowMinutes) {
  const nowIso = new Date().toISOString();
  const windowStart = new Date(Date.now() - windowMinutes * 60000).toISOString();
  const res = await db
    .prepare(
      "INSERT INTO rro_rate_hits (bucket, ip_hash, created_at_utc) SELECT ?1, ?2, ?3 " +
        "WHERE (SELECT COUNT(*) FROM rro_rate_hits WHERE bucket = ?1 AND ip_hash = ?2 AND created_at_utc >= ?4) < ?5"
    )
    .bind(bucket, ipHash, nowIso, windowStart, max)
    .run();
  return Number((res && res.meta && res.meta.changes) || 0) === 1;
}

function rroCookie(request, name) {
  const raw = String(request.headers.get("Cookie") || "");
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

// T1: in test mode the CTA is only offered to previewers. The preview link carries
// ?rro_preview=<exp>.<HMAC-SHA256(RRO_PREVIEW_SECRET, "rro-preview-link-v2:" + exp)>, where exp is a
// unix time at most 24h ahead (HMAC-covered, so it cannot be extended); a valid link sets an
// HttpOnly cookie "<expiry>.<HMAC(secret, 'rro-preview-cookie-v1:' + expiry)>" for 24h.
// No RRO_PREVIEW_SECRET (or one shorter than 24 chars) => preview never validates (fail closed).
const RRO_PREVIEW_TTL_SEC = 86400;
function rroPreviewSecret(env) {
  const s = env && env.RRO_PREVIEW_SECRET;
  return typeof s === "string" && s.length >= 24 ? s : null;
}
const RRO_PREVIEW_CLOCK_SKEW_SEC = 300;
async function rroPreviewLinkToken(secret, nowSec = Date.now() / 1000, ttlSec = RRO_PREVIEW_TTL_SEC) {
  const exp = Math.floor(nowSec) + Math.min(ttlSec, RRO_PREVIEW_TTL_SEC);
  return exp + "." + (await rroHmacSha256Hex(secret, "rro-preview-link-v2:" + exp));
}
async function rroPreviewCookieFor(secret, nowSec) {
  const exp = Math.floor(nowSec) + RRO_PREVIEW_TTL_SEC;
  return exp + "." + (await rroHmacSha256Hex(secret, "rro-preview-cookie-v1:" + exp));
}
async function rroPreviewCookieValid(request, env, nowSec = Date.now() / 1000) {
  const secret = rroPreviewSecret(env);
  const raw = rroCookie(request, RRO_PREVIEW_COOKIE);
  if (!secret || !raw) return false;
  const m = /^(\d{9,11})\.([0-9a-f]{64})$/.exec(raw);
  if (!m || Number(m[1]) <= nowSec) return false;
  return rroTimingSafeEqualHex(m[2], await rroHmacSha256Hex(secret, "rro-preview-cookie-v1:" + m[1]));
}
async function rroPreviewLinkValid(url, env, nowSec = Date.now() / 1000) {
  const secret = rroPreviewSecret(env);
  const given = url && url.searchParams.get(RRO_PREVIEW_COOKIE);
  if (!secret || !given) return false;
  const m = /^(\d{9,11})\.([0-9a-f]{64})$/.exec(given);
  if (!m) return false;
  const exp = Number(m[1]);
  // Expired links, and links claiming more than 24h of life, are refused.
  if (exp <= nowSec || exp > nowSec + RRO_PREVIEW_TTL_SEC + RRO_PREVIEW_CLOCK_SKEW_SEC) return false;
  return rroTimingSafeEqualHex(m[2], await rroHmacSha256Hex(secret, "rro-preview-link-v2:" + m[1]));
}

function rroTimingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function rroHmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]  — HMAC-SHA256 over `${t}.${rawBody}`.
async function rroVerifyStripeSignature(rawBody, header, secret, nowSec, toleranceSec = 300) {
  if (!secret) return { ok: false, reason: "STRIPE_WEBHOOK_SECRET_MISSING" };
  if (!header) return { ok: false, reason: "STRIPE_SIGNATURE_MISSING" };
  let t = null;
  const v1 = [];
  for (const part of String(header).split(",")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  if (!t || !/^\d{1,12}$/.test(t) || v1.length === 0) return { ok: false, reason: "STRIPE_SIGNATURE_MALFORMED" };
  const now = typeof nowSec === "number" ? nowSec : Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(t, 10)) > toleranceSec) return { ok: false, reason: "STRIPE_SIGNATURE_TIMESTAMP_OUT_OF_TOLERANCE" };
  const expected = await rroHmacSha256Hex(secret, t + "." + rawBody);
  const match = v1.some((sig) => rroTimingSafeEqualHex(sig.toLowerCase(), expected));
  return match ? { ok: true } : { ok: false, reason: "STRIPE_SIGNATURE_MISMATCH" };
}

function rroCleanInputs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const num = (v, d, lo, hi) => {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return d;
    return Math.max(lo, Math.min(hi, Math.round(n * 100) / 100));
  };
  const regions = ["London", "Southern", "Midlands", "Northern", "Eastern"];
  const region = regions.includes(String(src.region)) ? String(src.region) : "London";
  const role = String(src.party_role || src.role || "").toLowerCase().includes("tenant") ? "tenant_claim" : "landlord_defence";
  const mitigation = String(src.mitigation_factors || src.mitigation || "")
    .split(/[,;]/)
    .map((m) => m.trim().toLowerCase())
    .filter((m) => /^[a-z0-9_]{2,40}$/.test(m))
    .slice(0, 8)
    .join(",");
  return {
    monthly_rent_gbp: String(num(src.monthly_rent_gbp, 1800, 0, 100000)),
    months_unlicensed: String(Math.round(num(src.months_unlicensed, 12, 1, 24))),
    universal_credit_housing_gbp: String(num(src.universal_credit_housing_gbp, 0, 0, 100000)),
    utilities_included_monthly_gbp: String(num(src.utilities_included_monthly_gbp, 150, 0, 100000)),
    region,
    party_role: role,
    mitigation_factors: mitigation,
  };
}

function rroOriginAllowed(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  const selfOrigin = new URL(request.url).origin;
  return origin === selfOrigin || origin === RRO_PUBLIC_ORIGIN;
}

// Per-browser nonce: a random HttpOnly cookie set on /rro when the CTA is shown. It separates
// visitors who share one IP (NAT/CGNAT), so they never share a Stripe Checkout Session.
const RRO_BROWSER_NONCE_COOKIE = "rro_bn";
const RRO_BROWSER_NONCE_RE = /^[0-9a-f]{32}$/;
const RRO_BROWSER_NONCE_TTL_SEC = 86400;
function rroBrowserNonce(request) {
  const v = rroCookie(request, RRO_BROWSER_NONCE_COOKIE);
  return v && RRO_BROWSER_NONCE_RE.test(v) ? v : null;
}
function rroNewBrowserNonceCookie() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const v = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return RRO_BROWSER_NONCE_COOKIE + "=" + v + "; Path=/; Max-Age=" + RRO_BROWSER_NONCE_TTL_SEC + "; Secure; HttpOnly; SameSite=Lax";
}

// Deterministic Stripe Idempotency-Key per cart (the cleaned pack inputs) and browser (nonce cookie,
// daily IP hash and mode), bucketed to 10 minutes, so a retried or double-submitted checkout reuses
// one Checkout Session instead of creating duplicates. Without a valid nonce there is no dedupe:
// the caller gets null and Stripe gets a fresh random key.
const RRO_IDEMPOTENCY_BUCKET_SEC = 600;
async function rroCheckoutIdempotencyKey(mode, ipHash, nonce, inputs, nowSec = Date.now() / 1000) {
  if (!nonce || !RRO_BROWSER_NONCE_RE.test(String(nonce))) return null;
  const cart = Object.keys(inputs || {})
    .sort()
    .map((k) => k + "=" + String(inputs[k]))
    .join("&");
  const bucket = Math.floor(nowSec / RRO_IDEMPOTENCY_BUCKET_SEC);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("rro-checkout-v2|" + mode + "|" + ipHash + "|" + nonce + "|" + cart + "|" + bucket));
  return "rro-cs-" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

async function rroStripeRequest(env, method, path, form, idempotencyKey) {
  const headers = {
    Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
    "Stripe-Version": "2024-06-20",
  };
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["Idempotency-Key"] = idempotencyKey || crypto.randomUUID();
    body = new URLSearchParams(form).toString();
  }
  let resp;
  try {
    resp = await fetch("https://api.stripe.com" + path, { method, headers, body });
  } catch (_) {
    return { ok: false, status: 502, data: null };
  }
  let data = null;
  try {
    data = await resp.json();
  } catch (_) {
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data };
}


export {
  RRO_PACK_PRODUCT_KEY,
  RRO_PACK_PRODUCT_NAME,
  RRO_PACK_PRICE_PENCE,
  RRO_PACK_CURRENCY,
  RRO_PUBLIC_ORIGIN,
  RRO_CHECKOUT_RATE_LIMIT,
  RRO_LOOKUP_RATE_LIMIT,
  RRO_PAID_CACHE_TTL_MS,
  RRO_IP_HASH_RETENTION_HOURS,
  RRO_PREVIEW_COOKIE,
  RRO_TEST_MODE_LABEL,
  RRO_PACK_DOWNLOAD_DAYS,
  RRO_DAY7_RULE,
  RRO_SESSION_ID_RE,
  RRO_CHECKOUT_SCHEMA,
  RRO_INTERNAL_CACHE_PREFIX,
  RRO_OPPORTUNISTIC_PURGE_LIMIT,
  rroCacheRateLimitHit,
  rroReadCappedBody,
  rroPurgeIpHashesBounded,
  rroResetIsolateStateForTests,
  rroStripeMode,
  rroEnsureCheckoutSchema,
  rroJson,
  rroIpPepper,
  rroIpHash,
  rroPurgeIpHashes,
  rroRateLimitHit,
  rroCookie,
  RRO_PREVIEW_TTL_SEC,
  rroPreviewSecret,
  rroPreviewLinkToken,
  rroPreviewCookieFor,
  rroPreviewCookieValid,
  rroPreviewLinkValid,
  rroTimingSafeEqualHex,
  rroHmacSha256Hex,
  rroVerifyStripeSignature,
  rroCleanInputs,
  rroOriginAllowed,
  rroCheckoutIdempotencyKey,
  rroBrowserNonce,
  rroNewBrowserNonceCookie,
  rroStripeRequest,
};
