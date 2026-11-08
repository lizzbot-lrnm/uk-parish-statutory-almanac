// RRO £24 Stripe Checkout: formal pack, success page, /api/rro/* + /rro routing and CTA render.
import {
  RRO_LOOKUP_RATE_LIMIT,
  RRO_PREVIEW_COOKIE,
  RRO_TEST_MODE_LABEL,
  RRO_PACK_DOWNLOAD_DAYS,
  RRO_SESSION_ID_RE,
  rroStripeMode,
  rroEnsureCheckoutSchema,
  rroJson,
  rroIpPepper,
  rroIpHash,
  rroPurgeIpHashes,
  rroRateLimitHit,
  RRO_PREVIEW_TTL_SEC,
  rroPreviewSecret,
  rroPreviewCookieFor,
  rroPreviewCookieValid,
  rroPreviewLinkValid,
  rroCleanInputs,
  rroStripeRequest,
} from "./rro_core.js";
import {
  rroHandleCheckoutCreate,
  rroSessionIsPaidPack,
  rroRecordPaid,
  rroHandleStripeWebhook,
  rroBuildTelemetry,
  rroPublicTelemetry,
  rroTelemetryAuthorised,
  rroPaidCacheGet,
  rroPaidCachePut,
  rroPaidCacheApiGet,
  rroPaidCacheApiPut,
  rroPaidCacheProject,
} from "./rro_checkout.js";

// Site data/helpers that live in worker.js are injected (no circular import).
let D = {};
export function setRroDeps(deps) {
  D = deps;
}

function rroMdEscape(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function rroBuildFormalPack(session) {
  const md = session.metadata || {};
  const inputs = rroCleanInputs(md);
  const calc = D.calculateRroAwardEdge({ ...inputs, mitigation_factors: inputs.mitigation_factors });
  const regional = D.searchRroPrecedentsEdge({ region: inputs.region, limit: 500 });
  const c = calc.calculation || {};
  const role = inputs.party_role === "tenant_claim" ? "Applicant tenant(s) — RRO claim & quantum" : "Respondent landlord — s.44 mitigation & defence";
  const ref = String(session.id || "").slice(-10);
  const lines = [];
  lines.push("# Formal Tribunal Appeal Pack — Rent Repayment Order (RRO)");
  lines.push("");
  lines.push("First-tier Tribunal (Property Chamber) — Residential Property · Housing and Planning Act 2016 ss.40–44");
  lines.push("");
  lines.push("- Pack reference: `" + ref + "`");
  lines.push("- Generated (UTC): " + new Date().toISOString());
  lines.push("- Party role: " + role);
  lines.push("- Tribunal region: " + inputs.region);
  lines.push("- Data: " + D.RRO_PRECEDENTS.length + " GOV.UK FTT (Property Chamber) RRO decisions, Open Government Licence v3.0");
  lines.push("");
  lines.push("> Not legal advice. This pack is a deterministic, data-derived working bundle to support your own statement of case or appeal. Check every figure against your evidence and the full decision text before filing.");
  lines.push("");
  lines.push("## 1. Inputs");
  lines.push("");
  lines.push("| Item | Value |");
  lines.push("|---|---|");
  lines.push("| Monthly gross rent | £" + inputs.monthly_rent_gbp + " |");
  lines.push("| Months claimed (1–24) | " + inputs.months_unlicensed + " |");
  lines.push("| Universal Credit housing element (£/mo) | £" + inputs.universal_credit_housing_gbp + " |");
  lines.push("| Utilities / council tax included (£/mo) | £" + inputs.utilities_included_monthly_gbp + " |");
  lines.push("| Mitigation factors asserted | " + rroMdEscape(inputs.mitigation_factors || "none") + " |");
  lines.push("");
  lines.push("## 2. Quantum workings (Acheampong v Roman [2022] UKUT 239 (LC) four-stage approach)");
  lines.push("");
  lines.push("| Step | Figure |");
  lines.push("|---|---|");
  lines.push("| Gross rent in period | £" + c.gross_rent_in_period_gbp + " |");
  lines.push("| Less Universal Credit | £" + c.uc_deduction_gbp + " |");
  lines.push("| Less utilities | £" + c.utilities_deduction_gbp + " |");
  lines.push("| Net eligible rent (maximum RRO) | £" + c.net_eligible_rent_gbp + " |");
  lines.push("| Offence baseline median | " + c.offence_baseline_median_pct + "% |");
  lines.push("| Regional direct-award median | " + c.regional_direct_median_pct + "% |");
  lines.push("| Net s.44(4) conduct/mitigation adjustment | " + c.net_mitigation_pct_adjustment + " pts |");
  lines.push("| Predicted award band | " + c.predicted_award_pct_low + "% – " + c.predicted_award_pct_high + "% (median " + c.predicted_award_pct_median + "%) |");
  lines.push("| Predicted award £ band | £" + c.predicted_award_gbp_low + " – £" + c.predicted_award_gbp_high + " (median £" + c.predicted_award_gbp_median + ") |");
  lines.push("");
  lines.push("## 3. Scott Schedule");
  lines.push("");
  lines.push(String(calc.schedule_markdown || ""));
  lines.push("");
  lines.push("## 4. Closest comparable precedents");
  lines.push("");
  lines.push("| Case ref | Region | Offence | Claimed £ | Awarded £ | Award % | Decision |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const p of calc.comparable_precedents || []) {
    lines.push("| " + [p.case_ref, p.region, p.offence_type, p.claimed_gbp ?? "", p.awarded_gbp ?? "", p.award_pct_of_rent ?? "", p.pdf_url || ""].map(rroMdEscape).join(" | ") + " |");
  }
  lines.push("");
  lines.push("## 5. Regional bundle — " + inputs.region + " (" + (regional.stats ? regional.stats.total_matched : 0) + " decisions)");
  lines.push("");
  if (regional.stats) {
    lines.push("Median award " + regional.stats.median_award_pct + "% of rent · mean " + regional.stats.mean_award_pct + "% · median £" + regional.stats.median_award_gbp + ".");
    lines.push("");
  }
  lines.push("| Case ref | Date | Offence | Awarded £ | Award % | Source |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of (regional.results || []).slice(0, 60)) {
    lines.push("| " + [r.case_ref, r.decision_date, r.offence_type, r.awarded_gbp ?? "", r.award_pct_of_rent ?? "", r.award_source || ""].map(rroMdEscape).join(" | ") + " |");
  }
  lines.push("");
  lines.push("## 6. Grounds & procedure checklist");
  lines.push("");
  lines.push("- [ ] Offence proved beyond reasonable doubt (HPA 2016 s.43(1)); identify the s.40(3) offence (e.g. Housing Act 2004 s.72(1) / s.95(1)).");
  lines.push("- [ ] Application made within 12 months of the offence (HPA 2016 s.41(2)(b)).");
  lines.push("- [ ] Period and maximum: rent paid in the relevant period, less Universal Credit (s.44(3)).");
  lines.push("- [ ] s.44(4) factors evidenced: conduct of landlord and tenant, landlord's financial circumstances, any conviction.");
  lines.push("- [ ] Seriousness of offence placed against comparables (Williams v Parmar [2021] UKUT 244 (LC); Acheampong v Roman [2022] UKUT 239 (LC)).");
  lines.push("- [ ] Reasonable-excuse defence considered (Housing Act 2004 s.72(5) / s.95(4)).");
  lines.push("- [ ] Appeal: permission to appeal to the Upper Tribunal (Lands Chamber) must first be sought from the FTT, normally within 28 days of the written reasons being sent (FTT (Property Chamber) Rules 2013, r.52).");
  lines.push("");
  lines.push("_Source data: GOV.UK First-tier Tribunal (Property Chamber) decisions, Open Government Licence v3.0. Generated by parish.technoplusit.co.uk/rro._");
  const csv = [
    "# Scott Schedule",
    String(calc.schedule_csv || ""),
    "",
    "# Regional precedents (" + inputs.region + ")",
    D.exportRroPrecedentsCsv(regional.results || []),
  ].join("\n");
  return { markdown: lines.join("\n") + "\n", csv, calc, inputs };
}

function rroSessionWithinWindow(session) {
  const createdMs = Number((session && session.created) || 0) * 1000;
  return !(createdMs && Date.now() - createdMs > RRO_PACK_DOWNLOAD_DAYS * 86400000);
}

// T2 / W-M1: order is (1) config + shape checks, (2) per-ip_hash limit (slot reserved first),
// (3) D1 lookup: a session_id we never created/recorded -> 404 with NO Stripe call,
// (4) paid-verdict cache (<=10 min), (5) only then GET the session from Stripe.
async function rroLoadPaidSession(env, sessionId, request) {
  const mode = rroStripeMode(env);
  if (!mode.ok || !env.RRO_CHECKOUT_DB || !rroIpPepper(env)) return { ok: false, status: 503, error: "CHECKOUT_NOT_CONFIGURED" };
  if (!RRO_SESSION_ID_RE.test(String(sessionId || ""))) return { ok: false, status: 400, error: "INVALID_SESSION_ID" };
  const sessionMode = String(sessionId).startsWith("cs_live_") ? "live" : "test";
  if (sessionMode !== mode.mode) return { ok: false, status: 400, error: "SESSION_MODE_MISMATCH" };
  const db = env.RRO_CHECKOUT_DB;
  await rroEnsureCheckoutSchema(db);
  const ipHash = request ? await rroIpHash(request, env) : null;
  if (!ipHash) return { ok: false, status: 503, error: "CHECKOUT_NOT_CONFIGURED" };
  // No retention purge on this unauthenticated GET path: it runs from scheduled() and on checkout writes.
  if (!(await rroRateLimitHit(db, "pack_lookup", ipHash, RRO_LOOKUP_RATE_LIMIT.max_hits, RRO_LOOKUP_RATE_LIMIT.window_minutes))) {
    return { ok: false, status: 429, error: "RATE_LIMITED" };
  }
  const known = await db
    .prepare("SELECT kind FROM rro_checkout_events WHERE session_id = ?1 AND stripe_mode = ?2 LIMIT 1")
    .bind(sessionId, sessionMode)
    .first();
  if (!known) return { ok: false, status: 404, error: "SESSION_NOT_FOUND" };
  const cached = rroPaidCacheGet(sessionId) || (await rroPaidCacheApiGet(sessionId));
  if (cached && rroSessionIsPaidPack(cached) && cached.id === sessionId) {
    if (!rroSessionWithinWindow(cached)) return { ok: false, status: 410, error: "DOWNLOAD_EXPIRED" };
    return { ok: true, session: cached };
  }
  const res = await rroStripeRequest(env, "GET", "/v1/checkout/sessions/" + encodeURIComponent(sessionId));
  if (!res.ok || !res.data) return { ok: false, status: res.status === 404 ? 404 : 502, error: "SESSION_LOOKUP_FAILED" };
  const session = res.data;
  if (!rroSessionIsPaidPack(session)) return { ok: false, status: 402, error: "PAYMENT_NOT_COMPLETE" };
  if (session.id !== sessionId) return { ok: false, status: 502, error: "SESSION_LOOKUP_FAILED" };
  if (!rroSessionWithinWindow(session)) return { ok: false, status: 410, error: "DOWNLOAD_EXPIRED" };
  await rroRecordPaid(db, session);
  const minimal = rroPaidCacheProject(session);
  rroPaidCachePut(sessionId, minimal);
  await rroPaidCacheApiPut(sessionId, minimal);
  return { ok: true, session: minimal };
}

function rroSuccessPageHtml(sessionId, session) {
  const sid = encodeURIComponent(sessionId);
  const testBanner = session && session.livemode === false
    ? '<p style="background:#fef3c7;border:1px solid #f59e0b;padding:10px;border-radius:6px;"><strong>Stripe TEST MODE</strong> — no real money was taken.</p>'
    : "";
  return '<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Your Formal Tribunal Appeal Pack</title>' +
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#0f172a;line-height:1.5}a.btn{display:inline-block;margin:6px 8px 6px 0;padding:12px 16px;background:#1d4ed8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}a.sec{background:#475569}</style></head><body>' +
    "<h1>Payment received — Export Formal Tribunal Appeal Pack</h1>" + testBanner +
    "<p>Your pack is ready. Download links stay valid for " + RRO_PACK_DOWNLOAD_DAYS + " days from purchase; bookmark this page.</p>" +
    '<p><a class="btn" href="/api/rro/pack?format=md&amp;session_id=' + sid + '">Download Formal Appeal Pack (Markdown)</a>' +
    '<a class="btn sec" href="/api/rro/pack?format=csv&amp;session_id=' + sid + '">Download Schedule &amp; Precedents (CSV)</a></p>' +
    '<p><a href="/rro">&larr; Back to the RRO Precedent Finder</a></p>' +
    "<p style=\"font-size:13px;color:#64748b\">Not legal advice. Source data: GOV.UK First-tier Tribunal (Property Chamber), OGL v3.0.</p></body></html>";
}

const RRO_CHECKOUT_HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
};

async function rroHandleCheckoutRoutes(request, env, url) {
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/api/rro/checkout") return rroHandleCheckoutCreate(request, env);
  if (p === "/api/rro/stripe-webhook") return rroHandleStripeWebhook(request, env);
  if (p === "/api/rro/telemetry") {
    if (request.method !== "GET" && request.method !== "HEAD") return rroJson({ status: "error", error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET" });
    // T5: full counters/day-7 internals only with a bearer RRO_TELEMETRY_TOKEN (no CORS); public view is minimal.
    if (await rroTelemetryAuthorised(request, env)) return rroJson(await rroBuildTelemetry(env), 200);
    return rroJson(rroPublicTelemetry(env), 200, { "Access-Control-Allow-Origin": "*" });
  }
  if (p === "/rro/pack/success") {
    const sid = url.searchParams.get("session_id") || "";
    const loaded = await rroLoadPaidSession(env, sid, request);
    if (!loaded.ok) {
      const msg = loaded.error === "PAYMENT_NOT_COMPLETE" ? "Payment not completed yet. If you just paid, refresh in a few seconds." : "We could not verify this purchase (" + loaded.error + ").";
      return new Response('<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Formal Tribunal Appeal Pack</title></head><body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px"><h1>Formal Tribunal Appeal Pack</h1><p>' + D.escapeHtml(msg) + '</p><p><a href="/rro">Back to /rro</a></p></body></html>', { status: loaded.status, headers: RRO_CHECKOUT_HTML_HEADERS });
    }
    return new Response(rroSuccessPageHtml(sid, loaded.session), { headers: RRO_CHECKOUT_HTML_HEADERS });
  }
  if (p === "/api/rro/pack") {
    const sid = url.searchParams.get("session_id") || "";
    const loaded = await rroLoadPaidSession(env, sid, request);
    if (!loaded.ok) return rroJson({ status: "error", error: loaded.error }, loaded.status);
    const pack = rroBuildFormalPack(loaded.session);
    const fmt = String(url.searchParams.get("format") || "md").toLowerCase();
    const base = "formal-tribunal-appeal-pack-" + pack.inputs.region.toLowerCase() + "-" + String(sid).slice(-8);
    if (fmt === "csv") {
      return new Response(pack.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="' + base + '.csv"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    return new Response(pack.markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="' + base + '.md"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  return null;
}

// T1: render /rro with the CTA state for the current mode.
//   live (review+owner gated) -> normal £24 CTA
//   test + preview cookie/param -> CTA with an unmissable TEST MODE label
//   test without preview, or not configured -> no CTA at all (production visitors never see test checkout)
const RRO_CTA_NOTE_TEXT = "One-off £24 via secure Stripe Checkout: formal Scott Schedule, Acheampong quantum workings, closest GOV.UK comparables, full regional precedent bundle (Markdown + CSV) and s.44 grounds &amp; appeal checklist, built from the inputs above.";
async function rroRenderRroPage(request, env, url) {
  const mode = rroStripeMode(env);
  const configured = mode.ok && Boolean(env && env.RRO_CHECKOUT_DB && env.STRIPE_WEBHOOK_SECRET && rroIpPepper(env));
  const viaLink = await rroPreviewLinkValid(url, env);
  const preview = viaLink || (await rroPreviewCookieValid(request, env));
  let button = "";
  let note = "";
  let state = "hidden";
  if (configured && mode.mode === "live") {
    state = "live";
    button = '<button id="formalPackBtn" type="button" style="background:#1d4ed8;">Export Formal Tribunal Appeal Pack — £24</button>';
    note = '<p id="formalPackNote" style="font-size:13px;color:#475569;margin:6px 0 0;">' + RRO_CTA_NOTE_TEXT + "</p>";
  } else if (configured && mode.mode === "test" && preview) {
    state = "test_preview";
    button = '<button id="formalPackBtn" type="button" style="background:#b45309;">[TEST MODE] Export Formal Tribunal Appeal Pack — £24</button>';
    note =
      '<p id="rroTestModeBanner" role="alert" style="background:#fef3c7;border:2px solid #b45309;color:#78350f;padding:8px 10px;border-radius:6px;font-weight:700;margin:8px 0 0;">' +
      RRO_TEST_MODE_LABEL + ".</p>" +
      '<p id="formalPackNote" style="font-size:13px;color:#475569;margin:6px 0 0;">Stripe test checkout (preview only). ' + RRO_CTA_NOTE_TEXT + "</p>";
  }
  const html = D.RRO_HTML_PAGE.replace("<!--RRO_FORMAL_PACK_CTA_BUTTON-->", button).replace("<!--RRO_FORMAL_PACK_CTA_NOTE-->", note);
  // The page varies on the preview cookie: never let a shared cache serve one visitor's variant to another.
  const extra = { "X-RRO-CTA": state, "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store", Vary: "Cookie" };
  if (state === "test_preview") {
    if (viaLink) {
      // Strip the token from the URL bar, history and Referer: 302 to /rro carrying the signed cookie.
      const cookie = await rroPreviewCookieFor(rroPreviewSecret(env), Date.now() / 1000);
      extra["Set-Cookie"] = RRO_PREVIEW_COOKIE + "=" + cookie + "; Path=/; Max-Age=" + RRO_PREVIEW_TTL_SEC + "; Secure; HttpOnly; SameSite=Strict";
      extra.Location = "/rro";
      return { redirect: true, html: "", headers: extra };
    }
  }
  return { html, headers: extra };
}
// --------------------------- end RRO checkout ---------------------------

export { rroHandleCheckoutRoutes, rroRenderRroPage };
