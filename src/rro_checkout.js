// RRO £24 Stripe Checkout: session create, Stripe webhook, telemetry and paid-session cache.
import {
  RRO_PACK_PRODUCT_KEY,
  RRO_PACK_PRODUCT_NAME,
  RRO_PACK_PRICE_PENCE,
  RRO_PACK_CURRENCY,
  RRO_PUBLIC_ORIGIN,
  RRO_CHECKOUT_RATE_LIMIT,
  RRO_PAID_CACHE_TTL_MS,
  RRO_TEST_MODE_LABEL,
  RRO_DAY7_RULE,
  RRO_SESSION_ID_RE,
  rroStripeMode,
  rroEnsureCheckoutSchema,
  rroJson,
  rroIpPepper,
  rroIpHash,
  rroPurgeIpHashes,
  rroRateLimitHit,
  rroPreviewCookieValid,
  rroTimingSafeEqualHex,
  rroVerifyStripeSignature,
  rroCleanInputs,
  rroOriginAllowed,
  rroStripeRequest,
} from "./rro_core.js";

async function rroHandleCheckoutCreate(request, env) {
  if (request.method !== "POST") return rroJson({ status: "error", error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });
  if (!rroOriginAllowed(request)) return rroJson({ status: "error", error: "ORIGIN_NOT_ALLOWED" }, 403);
  // T5 / W-L3: one generic error for every misconfiguration; no reason/env/binding names in the body.
  const mode = rroStripeMode(env);
  if (!mode.ok || !env.RRO_CHECKOUT_DB || !env.STRIPE_WEBHOOK_SECRET || !rroIpPepper(env)) {
    return rroJson({ status: "error", error: "CHECKOUT_NOT_CONFIGURED" }, 503);
  }
  // T1: test-mode checkout is preview-only so unaware real visitors never land on a Stripe test page.
  if (mode.mode === "test" && !(await rroPreviewCookieValid(request, env))) {
    return rroJson({ status: "error", error: "CHECKOUT_NOT_CONFIGURED" }, 503);
  }

  const ctype = String(request.headers.get("Content-Type") || "").toLowerCase();
  let raw = {};
  const isForm = ctype.includes("application/x-www-form-urlencoded");
  try {
    const text = (await request.text()).slice(0, 4096);
    if (ctype.includes("application/json")) raw = text ? JSON.parse(text) : {};
    else if (isForm) raw = Object.fromEntries(new URLSearchParams(text));
    else return rroJson({ status: "error", error: "UNSUPPORTED_CONTENT_TYPE" }, 415);
  } catch (_) {
    return rroJson({ status: "error", error: "INVALID_BODY" }, 400);
  }
  const inputs = rroCleanInputs(raw);

  const db = env.RRO_CHECKOUT_DB;
  await rroEnsureCheckoutSchema(db);
  const ipHash = await rroIpHash(request, env);
  if (!ipHash) return rroJson({ status: "error", error: "CHECKOUT_NOT_CONFIGURED" }, 503);
  await rroPurgeIpHashes(db);
  const allowed = await rroRateLimitHit(db, "checkout", ipHash, RRO_CHECKOUT_RATE_LIMIT.max_starts, RRO_CHECKOUT_RATE_LIMIT.window_minutes);
  if (!allowed) {
    return rroJson({ status: "error", error: "RATE_LIMITED" }, 429, { "Retry-After": String(RRO_CHECKOUT_RATE_LIMIT.window_minutes * 60) });
  }

  const form = {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": RRO_PACK_CURRENCY,
    "line_items[0][price_data][unit_amount]": String(RRO_PACK_PRICE_PENCE),
    "line_items[0][price_data][product_data][name]": RRO_PACK_PRODUCT_NAME,
    "line_items[0][price_data][product_data][description]":
      "Formal First-tier Tribunal (Property Chamber) RRO appeal pack: Scott Schedule, quantum workings, comparable GOV.UK precedents and s.44 grounds checklist.",
    success_url: RRO_PUBLIC_ORIGIN + "/rro/pack/success?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: RRO_PUBLIC_ORIGIN + "/rro?checkout=cancelled",
    "metadata[product]": RRO_PACK_PRODUCT_KEY,
    "payment_intent_data[metadata][product]": RRO_PACK_PRODUCT_KEY,
  };
  for (const [k, v] of Object.entries(inputs)) form["metadata[" + k + "]"] = v;
  if (mode.mode === "test") form["custom_text[submit][message]"] = RRO_TEST_MODE_LABEL + ".";

  const res = await rroStripeRequest(env, "POST", "/v1/checkout/sessions", form);
  if (!res.ok || !res.data || typeof res.data.url !== "string" || !res.data.id) {
    return rroJson({ status: "error", error: "STRIPE_SESSION_CREATE_FAILED" }, 502);
  }
  let checkoutUrl;
  try {
    checkoutUrl = new URL(res.data.url);
  } catch (_) {
    checkoutUrl = null;
  }
  if (!checkoutUrl || checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") {
    return rroJson({ status: "error", error: "STRIPE_SESSION_URL_UNEXPECTED" }, 502);
  }

  await db
    .prepare("INSERT OR IGNORE INTO rro_checkout_events (kind, stripe_mode, session_id, ip_hash, amount_total, currency, created_at_utc) VALUES ('checkout_start', ?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(mode.mode, res.data.id, ipHash, RRO_PACK_PRICE_PENCE, RRO_PACK_CURRENCY, new Date().toISOString())
    .run();

  if (isForm) {
    return new Response(null, { status: 303, headers: { Location: checkoutUrl.toString(), "Cache-Control": "no-store" } });
  }
  return rroJson({ status: "ok", mode: mode.mode, session_id: res.data.id, url: checkoutUrl.toString() });
}

function rroSessionIsPaidPack(session) {
  return Boolean(
    session &&
      session.object === "checkout.session" &&
      session.payment_status === "paid" &&
      session.metadata &&
      session.metadata.product === RRO_PACK_PRODUCT_KEY &&
      Number(session.amount_total) === RRO_PACK_PRICE_PENCE &&
      String(session.currency).toLowerCase() === RRO_PACK_CURRENCY
  );
}

async function rroRecordPaid(db, session) {
  await rroEnsureCheckoutSchema(db);
  const res = await db
    .prepare("INSERT OR IGNORE INTO rro_checkout_events (kind, stripe_mode, session_id, ip_hash, amount_total, currency, created_at_utc) VALUES ('paid', ?1, ?2, NULL, ?3, ?4, ?5)")
    .bind(session.livemode ? "live" : "test", session.id, Number(session.amount_total), String(session.currency).toLowerCase(), new Date().toISOString())
    .run();
  return Boolean(res && res.meta && res.meta.changes > 0);
}

async function rroHandleStripeWebhook(request, env) {
  if (request.method !== "POST") return rroJson({ status: "error", error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });
  if (!env.STRIPE_WEBHOOK_SECRET || !env.RRO_CHECKOUT_DB) return rroJson({ status: "error", error: "WEBHOOK_NOT_CONFIGURED" }, 503);
  // W-L2: refuse oversize bodies from Content-Length before reading; keep the post-read check too.
  const declaredLen = Number(request.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLen) && declaredLen > 256 * 1024) return rroJson({ status: "error", error: "PAYLOAD_TOO_LARGE" }, 413);
  const rawBody = await request.text();
  if (rawBody.length > 256 * 1024) return rroJson({ status: "error", error: "PAYLOAD_TOO_LARGE" }, 413);
  const ver = await rroVerifyStripeSignature(rawBody, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!ver.ok) return rroJson({ status: "error", error: "SIGNATURE_VERIFICATION_FAILED" }, 400);
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (_) {
    return rroJson({ status: "error", error: "INVALID_JSON" }, 400);
  }
  const type = event && event.type;
  if (type !== "checkout.session.completed" && type !== "checkout.session.async_payment_succeeded") {
    return rroJson({ status: "ok", ignored: true, type: String(type || "") });
  }
  const session = event.data && event.data.object;
  if (!rroSessionIsPaidPack(session) || !RRO_SESSION_ID_RE.test(String(session.id || ""))) {
    return rroJson({ status: "ok", ignored: true, reason: "NOT_A_PAID_FORMAL_PACK_SESSION" });
  }
  const inserted = await rroRecordPaid(env.RRO_CHECKOUT_DB, session);
  return rroJson({ status: "ok", recorded: inserted, duplicate: !inserted });
}

async function rroCountEvents(db, kind, stripeMode, sinceIso) {
  const row = sinceIso
    ? await db.prepare("SELECT COUNT(*) AS n FROM rro_checkout_events WHERE kind = ?1 AND stripe_mode = ?2 AND created_at_utc >= ?3").bind(kind, stripeMode, sinceIso).first()
    : await db.prepare("SELECT COUNT(*) AS n FROM rro_checkout_events WHERE kind = ?1 AND stripe_mode = ?2").bind(kind, stripeMode).first();
  return Number((row && row.n) || 0);
}

function rroValidIso(s) {
  if (!s) return null;
  const d = new Date(String(s));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function rroBuildTelemetry(env, nowMs) {
  const mode = rroStripeMode(env);
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const since = rroValidIso(env && env.RRO_CHECKOUT_LIVE_SINCE);
  const out = {
    status: "ok",
    product: RRO_PACK_PRODUCT_KEY,
    price_gbp: RRO_PACK_PRICE_PENCE / 100,
    stripe_mode: mode.mode,
    checkout_starts: 0,
    paid: 0,
    since,
    by_mode: { test: { checkout_starts: 0, paid: 0 }, live: { checkout_starts: 0, paid: 0 } },
    day7_kill_rule: { ...RRO_DAY7_RULE, clock_started_at_utc: since, evaluate_at_utc: null, verdict: "clock_not_started" },
    generated_at_utc: new Date(now).toISOString(),
  };
  if (!env || !env.RRO_CHECKOUT_DB) {
    out.status = "degraded";
    return out;
  }
  const db = env.RRO_CHECKOUT_DB;
  await rroEnsureCheckoutSchema(db);
  for (const m of ["test", "live"]) {
    out.by_mode[m].checkout_starts = await rroCountEvents(db, "checkout_start", m, m === "live" ? since : null);
    out.by_mode[m].paid = await rroCountEvents(db, "paid", m, m === "live" ? since : null);
  }
  const active = mode.mode === "live" ? "live" : "test";
  out.checkout_starts = out.by_mode[active].checkout_starts;
  out.paid = out.by_mode[active].paid;
  if (since) {
    const evalAt = new Date(new Date(since).getTime() + RRO_DAY7_RULE.window_days * 86400000);
    out.day7_kill_rule.evaluate_at_utc = evalAt.toISOString();
    const liveStarts = out.by_mode.live.checkout_starts;
    const livePaid = out.by_mode.live.paid;
    const fails = liveStarts < RRO_DAY7_RULE.min_checkout_starts || livePaid < RRO_DAY7_RULE.min_paid;
    if (now < evalAt.getTime()) out.day7_kill_rule.verdict = fails ? "running_below_threshold" : "running_threshold_met";
    else out.day7_kill_rule.verdict = fails ? "KILL" : "SURVIVES";
  }
  return out;
}

// T5 / W-L3: public (CORS *) view = status + mode label only. No counts, no revenue, no
// key-presence (live_blocked collapses to "unavailable"), no env/binding names, no kill-rule internals.
function rroPublicTelemetry(env) {
  const mode = rroStripeMode(env);
  const configured = mode.ok && Boolean(env && env.RRO_CHECKOUT_DB && env.STRIPE_WEBHOOK_SECRET && rroIpPepper(env));
  return {
    status: "ok",
    product: RRO_PACK_PRODUCT_KEY,
    price_gbp: RRO_PACK_PRICE_PENCE / 100,
    mode: configured ? mode.mode : "unavailable",
  };
}

function rroTelemetryAuthorised(request, env) {
  const token = typeof (env && env.RRO_TELEMETRY_TOKEN) === "string" ? env.RRO_TELEMETRY_TOKEN : "";
  if (token.length < 24) return false;
  const auth = String(request.headers.get("Authorization") || "");
  if (!auth.startsWith("Bearer ")) return false;
  return rroTimingSafeEqualHex(auth.slice(7), token);
}

// T2: per-isolate paid-verdict cache (<=10 min), bounded. Cache API is used opportunistically too.
const RRO_PAID_CACHE = new Map();
function rroPaidCacheGet(sessionId) {
  const hit = RRO_PAID_CACHE.get(sessionId);
  if (!hit) return null;
  if (Date.now() - hit.at > RRO_PAID_CACHE_TTL_MS) {
    RRO_PAID_CACHE.delete(sessionId);
    return null;
  }
  return hit.session;
}
function rroPaidCachePut(sessionId, session) {
  if (RRO_PAID_CACHE.size >= 500) RRO_PAID_CACHE.delete(RRO_PAID_CACHE.keys().next().value);
  RRO_PAID_CACHE.set(sessionId, { at: Date.now(), session });
}
const RRO_PAID_CACHE_URL = "https://parish.technoplusit.co.uk/__internal_rro_paid_v1/";
async function rroPaidCacheApiGet(sessionId) {
  try {
    if (typeof caches === "undefined" || !caches.default) return null;
    const r = await caches.default.match(RRO_PAID_CACHE_URL + encodeURIComponent(sessionId));
    return r ? await r.json() : null;
  } catch (_) {
    return null;
  }
}
async function rroPaidCacheApiPut(sessionId, session) {
  try {
    if (typeof caches === "undefined" || !caches.default) return;
    await caches.default.put(
      RRO_PAID_CACHE_URL + encodeURIComponent(sessionId),
      new Response(JSON.stringify(session), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600" } })
    );
  } catch (_) {}
}


export {
  rroHandleCheckoutCreate,
  rroSessionIsPaidPack,
  rroRecordPaid,
  rroHandleStripeWebhook,
  rroCountEvents,
  rroValidIso,
  rroBuildTelemetry,
  rroPublicTelemetry,
  rroTelemetryAuthorised,
  RRO_PAID_CACHE,
  rroPaidCacheGet,
  rroPaidCachePut,
  RRO_PAID_CACHE_URL,
  rroPaidCacheApiGet,
  rroPaidCacheApiPut,
};
