// RRO £24 Stripe Checkout: formal pack, success page, /api/rro/* + /rro routing and CTA render.
import {
  RRO_LOOKUP_RATE_LIMIT,
  RRO_STRIPE_LOOKUP_GLOBAL_CAP,
  RRO_PREVIEW_COOKIE,
  RRO_TEST_MODE_LABEL,
  RRO_PACK_DOWNLOAD_DAYS,
  RRO_SESSION_ID_RE,
  rroStripeMode,
  rroWebhookSecret,
  rroEnsureCheckoutSchema,
  rroJson,
  rroIpPepper,
  rroIpHash,
  rroCacheRateLimitHit,
  rroD1CounterHit,
  rroRetryAfterSec,
  rroNotPaidCacheGet,
  rroNotPaidCachePut,
  RRO_PREVIEW_TTL_SEC,
  rroPreviewSecret,
  rroPreviewCookieFor,
  rroPreviewCookieValid,
  rroPreviewLinkValid,
  rroCleanInputs,
  rroBrowserNonce,
  rroNewBrowserNonceCookie,
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
  lines.push("# Formal Tribunal Application Pack — Rent Repayment Order (RRO)");
  lines.push("");
  lines.push("First-tier Tribunal (Property Chamber) — Residential Property · Housing and Planning Act 2016 ss.40–44");
  lines.push("");
  lines.push("- Pack reference: `" + ref + "`");
  lines.push("- Generated (UTC): " + new Date().toISOString());
  lines.push("- Party role: " + role);
  lines.push("- Tribunal region: " + inputs.region);
  lines.push("- Data: " + D.RRO_PRECEDENTS.length + " GOV.UK FTT (Property Chamber) RRO decisions, Open Government Licence v3.0");
  lines.push("");
  lines.push("> Not legal advice. This pack is a deterministic, data-derived working bundle to support your own statement of case for an application to the First-tier Tribunal. Check every figure against your evidence and the full decision text before filing.");
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
  // Fail closed: a missing, zero, negative or non-finite `created` is treated as outside the window.
  const created = Number(session && session.created);
  if (!Number.isFinite(created) || created <= 0) return false;
  return Date.now() - created * 1000 <= RRO_PACK_DOWNLOAD_DAYS * 86400000;
}

// T2 / W-M1 + P2/P3: order is (1) session id shape check before anything else, (2) config checks,
// (3) per-ip_hash fixed-window pre-filter in caches.default / isolate memory (no D1 write; an over-limit
// flood stops here), (4) P3: the same per-ip_hash limit as a GLOBAL D1 counter (one conditional upsert,
// nothing written once over the limit), (5) D1 read: a session_id we never created/recorded -> 404 with
// NO Stripe call, (6) paid-verdict cache (<=10 min), (7) P2: "not paid" verdict cache (30 s) unless the
// webhook has already recorded 'paid', (8) P2: global Stripe-lookup cap (D1, all IPs), (9) only then
// GET the session from Stripe. Internal error codes are mapped to generic public ones (P16) by the routes.
async function rroLoadPaidSession(env, sessionId, request) {
  if (!RRO_SESSION_ID_RE.test(String(sessionId || ""))) return { ok: false, status: 400, error: "INVALID_SESSION_ID" };
  const mode = rroStripeMode(env);
  if (!mode.ok || !env.RRO_CHECKOUT_DB || !rroWebhookSecret(env) || !rroIpPepper(env)) return { ok: false, status: 503, error: "CHECKOUT_NOT_CONFIGURED" };
  const sessionMode = String(sessionId).startsWith("cs_live_") ? "live" : "test";
  // P16: a session id for the other mode is simply "not found" (a 400 here revealed the configured mode).
  if (sessionMode !== mode.mode) return { ok: false, status: 404, error: "SESSION_MODE_MISMATCH" };
  const db = env.RRO_CHECKOUT_DB;
  const ipHash = request ? await rroIpHash(request, env) : null;
  if (!ipHash) return { ok: false, status: 503, error: "CHECKOUT_NOT_CONFIGURED" };
  const lim = RRO_LOOKUP_RATE_LIMIT;
  const rateLimited = { ok: false, status: 429, error: "RATE_LIMITED", retryAfterSec: rroRetryAfterSec(lim.window_minutes) };
  if (!(await rroCacheRateLimitHit("pack_lookup", ipHash, lim.max_hits, lim.window_minutes))) return rateLimited;
  await rroEnsureCheckoutSchema(db);
  if (!(await rroD1CounterHit(db, "pack_lookup", ipHash, lim.max_hits, lim.window_minutes))) return rateLimited;
  const known = await db
    .prepare("SELECT COUNT(*) AS n, MAX(kind = 'paid') AS paid FROM rro_checkout_events WHERE session_id = ?1 AND stripe_mode = ?2")
    .bind(sessionId, sessionMode)
    .first();
  if (!known || !Number(known.n)) return { ok: false, status: 404, error: "SESSION_NOT_FOUND" };
  const cached = rroPaidCacheGet(sessionId) || (await rroPaidCacheApiGet(sessionId));
  if (cached && rroSessionIsPaidPack(cached) && cached.id === sessionId) {
    if (!rroSessionWithinWindow(cached)) return { ok: false, status: 410, error: "DOWNLOAD_EXPIRED" };
    return { ok: true, session: cached };
  }
  // P2: short-circuit repeat lookups of a session Stripe just said is unpaid/unknown. A 'paid' row from the
  // verified webhook skips this, so a buyer who refreshes right after paying is not held back 30 s.
  if (!Number(known.paid)) {
    const neg = await rroNotPaidCacheGet(sessionId);
    if (neg) return { ok: false, status: neg.status, error: neg.error, cachedVerdict: true };
  }
  const cap = RRO_STRIPE_LOOKUP_GLOBAL_CAP;
  if (!(await rroD1CounterHit(db, "stripe_lookup", "global", cap.max_hits, cap.window_minutes))) {
    return { ok: false, status: 503, error: "STRIPE_LOOKUP_GLOBAL_CAP" };
  }
  const res = await rroStripeRequest(env, "GET", "/v1/checkout/sessions/" + encodeURIComponent(sessionId));
  if (!res.ok || !res.data) {
    if (res.status === 404) {
      const verdict = { status: 404, error: "SESSION_LOOKUP_FAILED" };
      await rroNotPaidCachePut(sessionId, verdict);
      return { ok: false, ...verdict };
    }
    return { ok: false, status: 502, error: "SESSION_LOOKUP_FAILED" };
  }
  const session = res.data;
  if (!rroSessionIsPaidPack(session)) {
    const verdict = { status: 402, error: "PAYMENT_NOT_COMPLETE" };
    await rroNotPaidCachePut(sessionId, verdict);
    return { ok: false, ...verdict };
  }
  if (session.id !== sessionId) return { ok: false, status: 502, error: "SESSION_LOOKUP_FAILED" };
  // Stripe's own livemode flag must agree with the key mode (same check as the webhook).
  if (Boolean(session.livemode) !== (sessionMode === "live")) return { ok: false, status: 502, error: "SESSION_MODE_MISMATCH" };
  if (!rroSessionWithinWindow(session)) return { ok: false, status: 410, error: "DOWNLOAD_EXPIRED" };
  await rroRecordPaid(db, session);
  const minimal = rroPaidCacheProject(session);
  rroPaidCachePut(sessionId, minimal);
  await rroPaidCacheApiPut(sessionId, minimal);
  return { ok: true, session: minimal };
}

// P16: anonymous callers only ever see one of these generic codes; the internal code (which can reveal
// configuration state, key mode or expiry logic) goes to the Worker log only, without the session id.
const RRO_PACK_PUBLIC_ERRORS = Object.freeze({
  400: "INVALID_REQUEST",
  402: "PAYMENT_NOT_COMPLETE",
  404: "NOT_FOUND",
  410: "NOT_AVAILABLE",
  429: "RATE_LIMITED",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
});
function rroPackPublicError(loaded, route) {
  const status = Number(loaded && loaded.status) || 503;
  console.log(JSON.stringify({ event: route === "success" ? "rro_pack_success_error" : "rro_pack_error", error: String((loaded && loaded.error) || "UNKNOWN"), status, cached: Boolean(loaded && loaded.cachedVerdict) }));
  const headers = status === 429 ? { "Retry-After": String((loaded && loaded.retryAfterSec) || 600) } : {};
  return { status, error: RRO_PACK_PUBLIC_ERRORS[status] || "UNAVAILABLE", headers };
}

function rroSuccessPageHtml(sessionId, session) {
  const sid = encodeURIComponent(sessionId);
  const testBanner = session && session.livemode === false
    ? '<p style="background:#fef3c7;border:1px solid #f59e0b;padding:10px;border-radius:6px;"><strong>Stripe TEST MODE</strong> — no real money was taken.</p>'
    : "";
  return '<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Your Formal Tribunal Application Pack</title>' +
    '<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#0f172a;line-height:1.5}a.btn{display:inline-block;margin:6px 8px 6px 0;padding:12px 16px;background:#1d4ed8;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}a.sec{background:#475569}</style></head><body>' +
    "<h1>Payment received — Export Formal Tribunal Application Pack</h1>" + testBanner +
    "<p>Your pack is ready. Download links stay valid for " + RRO_PACK_DOWNLOAD_DAYS + " days from purchase; bookmark this page.</p>" +
    '<p><a class="btn" href="/api/rro/pack?format=md&amp;session_id=' + sid + '">Download Formal Application Pack (Markdown)</a>' +
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
    if (request.method !== "GET" && request.method !== "HEAD") return rroJson({ status: "error", error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET, HEAD" });
    // T5: full counters/day-7 internals only with a bearer RRO_TELEMETRY_TOKEN (no CORS); public view is minimal.
    if (await rroTelemetryAuthorised(request, env)) return rroJson(await rroBuildTelemetry(env), 200);
    return rroJson(rroPublicTelemetry(env), 200, { "Access-Control-Allow-Origin": "*" });
  }
  if ((p === "/rro/pack/success" || p === "/api/rro/pack") && request.method !== "GET" && request.method !== "HEAD") {
    return rroJson({ status: "error", error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "GET, HEAD" });
  }
  if (p === "/rro/pack/success") {
    const sid = url.searchParams.get("session_id") || "";
    const loaded = await rroLoadPaidSession(env, sid, request);
    if (!loaded.ok) {
      // Internal error codes stay in logs only (no session id, URL or token); the visitor sees generic text.
      const pub = rroPackPublicError(loaded, "success");
      const msg = pub.error === "PAYMENT_NOT_COMPLETE"
        ? "Payment not completed yet. If you just paid, refresh in a few seconds."
        : "We could not verify this purchase right now. If you have paid, keep your Stripe receipt and try this link again later.";
      return new Response('<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Formal Tribunal Application Pack</title></head><body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px"><h1>Formal Tribunal Application Pack</h1><p>' + D.escapeHtml(msg) + '</p><p><a href="/rro">Back to /rro</a></p></body></html>', { status: pub.status, headers: { ...RRO_CHECKOUT_HTML_HEADERS, ...pub.headers } });
    }
    return new Response(rroSuccessPageHtml(sid, loaded.session), { headers: RRO_CHECKOUT_HTML_HEADERS });
  }
  if (p === "/api/rro/pack") {
    const sid = url.searchParams.get("session_id") || "";
    const loaded = await rroLoadPaidSession(env, sid, request);
    if (!loaded.ok) {
      const pub = rroPackPublicError(loaded, "pack");
      return rroJson({ status: "error", error: pub.error }, pub.status, pub.headers);
    }
    const pack = rroBuildFormalPack(loaded.session);
    const fmt = String(url.searchParams.get("format") || "md").toLowerCase();
    const base = "formal-tribunal-application-pack-" + pack.inputs.region.toLowerCase() + "-" + String(sid).slice(-8);
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
const RRO_CTA_NOTE_TEXT = "One-off £24 via secure Stripe Checkout: formal Scott Schedule, Acheampong quantum workings, closest GOV.UK comparables, full regional precedent bundle (Markdown + CSV) and s.44 grounds &amp; procedure checklist, built from the inputs above. This is not legal advice and it does not file Form RRO1 for you.";
// Disabled state (keys unset): describe the optional pack, say plainly it cannot be bought yet. No button.
const RRO_CTA_DISABLED_TEXT = "Optional Export Formal Tribunal Application Pack (£24): a formal Scott Schedule, quantum workings, closest published comparables, regional precedent bundle (Markdown and CSV), and a grounds and procedure checklist, built from the calculator inputs above. Checkout is not enabled on this page yet, so this pack cannot be purchased today. Searching and CSV download stay free. This is not legal advice.";

// ---- SEO: visible FAQ + JSON-LD built from one source so the two always match word-for-word ----
const RRO_PAGE_URL = "https://parish.technoplusit.co.uk/rro";
const RRO_PAGE_DESCRIPTION = "Search 281 published First-tier Tribunal Rent Repayment Order decisions. See the 60% median award and run a free calculator. Formal pack coming soon.";
const RRO_PACK_PRICE_GBP = "24.00";
const RRO_FAQ = [
  ["What is a rent repayment order?", "A rent repayment order is an order of the First-tier Tribunal (Property Chamber) requiring a landlord who has committed a specified housing offence to repay rent, or, where a local housing authority applies, rent paid through Housing Benefit or Universal Credit. The current list of offences and time limits is in official GOV.UK guidance. This page indexes published tribunal decisions; it does not replace that guidance."],
  ["Who can apply?", "A tenant, or a local housing authority, may apply (Housing and Planning Act 2016 s.41). In England, local housing authorities are district, unitary and London borough councils (and the City of London bodies named in Housing Act 2004 s.261) — not parish or town councils. A local housing authority may apply only in respect of housing in its area, after serving a notice of intended proceedings."],
  ["How much do tribunals award?", "In this index of 281 published decisions, the median award share shown on this page is 60% and the mean is 60.3%. That is a description of this dataset, not a guarantee or a recommended claim figure. Awards in individual cases range widely once utilities, Universal Credit / Housing Benefit, and other s.44 factors are taken into account."],
  ["What changed on 1 May 2026?", "For qualifying offences committed on or after 1 May 2026, official guidance describes a longer maximum repayment period (up to 24 months’ rent) and a longer period in which to apply (two years). Offences committed before that date can still be subject to the earlier rules (including a 12-month cap and a one-year application window). Check the date of the alleged offence against current GOV.UK guidance before relying on either figure."],
  ["What is free, and what is the £24 pack?", "Searching the index, downloading a regional or filtered CSV of published decisions, using the s.44 calculator, and running the private claim check are free. The optional “Export Formal Tribunal Application Pack” is a one-off £24 Stripe Checkout export of a formal Scott Schedule, quantum workings, closest published comparables, a regional precedent bundle, and a grounds and procedure checklist, built from the calculator inputs. It is not legal advice, it is not Form RRO1, and it does not file an application for you. If checkout is not yet enabled on this page, the pack cannot be purchased."],
  ["Where does the data come from?", "The index is built from published First-tier Tribunal (Property Chamber) decisions on GOV.UK, reused under the Open Government Licence v3.0. It is not a complete record of every RRO ever made. Always open the official PDF linked from each row before relying on a case."],
];
function rroFaqHtml() {
  const items = RRO_FAQ.map(([q, a]) => "      <dt>" + D.escapeHtml(q) + "</dt>\n      <dd>" + D.escapeHtml(a) + "</dd>").join("\n");
  return '<div class="card faq" id="rro-faq">\n    <h2>3. Frequently asked questions</h2>\n    <dl>\n' + items + "\n    </dl>\n  </div>";
}
// The pack Offer only says InStock when the live CTA is actually shown. Every other state (keys unset,
// malformed, test mode, test preview) says OutOfStock: the pack cannot be bought by a public visitor.
function rroJsonLd(ctaState) {
  const graph = [
    {
      "@type": "WebApplication",
      "@id": RRO_PAGE_URL + "#app",
      name: "Rent Repayment Order (RRO) tribunal precedents",
      url: RRO_PAGE_URL,
      description: RRO_PAGE_DESCRIPTION,
      inLanguage: "en-GB",
      applicationCategory: "LegalService",
      operatingSystem: "Any (web browser)",
      isAccessibleForFree: true,
    },
    {
      "@type": "Product",
      "@id": RRO_PAGE_URL + "#formal-pack",
      name: "Export Formal Tribunal Application Pack",
      description: "Optional one-off export built from the calculator inputs: formal Scott Schedule, quantum workings, closest published comparables, regional precedent bundle (Markdown and CSV), and a grounds and procedure checklist. Not legal advice; not Form RRO1.",
      url: RRO_PAGE_URL,
      offers: {
        "@type": "Offer",
        price: RRO_PACK_PRICE_GBP,
        priceCurrency: "GBP",
        url: RRO_PAGE_URL,
        availability: ctaState === "live" ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      },
    },
    {
      "@type": "FAQPage",
      "@id": RRO_PAGE_URL + "#faq",
      mainEntity: RRO_FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
    },
    {
      "@type": "Dataset",
      "@id": RRO_PAGE_URL + "#dataset",
      name: "Published First-tier Tribunal Rent Repayment Order decisions (index)",
      description: "Index of 281 published First-tier Tribunal (Property Chamber) Rent Repayment Order decisions on GOV.UK.",
      url: RRO_PAGE_URL,
      license: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
      // The index is compiled by this site; HMCTS/GOV.UK only published the underlying decisions.
      creator: { "@type": "Organization", name: "TechnoPlusIT" },
      isBasedOn: "https://www.gov.uk/residential-property-tribunal-decisions",
      isAccessibleForFree: true,
    },
  ];
  // Escape "<" so no string can close the script element early.
  const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
  return '<script type="application/ld+json" id="rroJsonLd">' + json + "</script>";
}
async function rroRenderRroPage(request, env, url) {
  const mode = rroStripeMode(env);
  const configured = mode.ok && Boolean(env && env.RRO_CHECKOUT_DB && rroWebhookSecret(env) && rroIpPepper(env));
  const viaLink = await rroPreviewLinkValid(url, env);
  const preview = viaLink || (await rroPreviewCookieValid(request, env));
  let button = "";
  let note = "";
  let state = "hidden";
  // Default (no usable Stripe test config, or a test key without preview): a plain "coming soon"
  // notice. No button, no link, no checkout call; X-RRO-CTA stays "hidden".
  note = '<p id="formalPackComingSoon" style="font-size:13px;color:#475569;margin:6px 0 0;">' + RRO_CTA_DISABLED_TEXT + "</p>";
  if (configured && mode.mode === "live") {
    state = "live";
    button = '<button id="formalPackBtn" type="button" style="background:#1d4ed8;">Export Formal Tribunal Application Pack — £24</button>';
    note = '<p id="formalPackNote" style="font-size:13px;color:#475569;margin:6px 0 0;">' + RRO_CTA_NOTE_TEXT + "</p>";
  } else if (configured && mode.mode === "test" && preview) {
    state = "test_preview";
    button = '<button id="formalPackBtn" type="button" style="background:#b45309;">[TEST MODE] Export Formal Tribunal Application Pack — £24</button>';
    note =
      '<p id="rroTestModeBanner" role="alert" style="background:#fef3c7;border:2px solid #b45309;color:#78350f;padding:8px 10px;border-radius:6px;font-weight:700;margin:8px 0 0;">' +
      RRO_TEST_MODE_LABEL + ".</p>" +
      '<p id="formalPackNote" style="font-size:13px;color:#475569;margin:6px 0 0;">Stripe test checkout (preview only). ' + RRO_CTA_NOTE_TEXT + "</p>";
  }
  const html = D.RRO_HTML_PAGE.replace("<!--RRO_FORMAL_PACK_CTA_BUTTON-->", () => button)
    .replace("<!--RRO_FORMAL_PACK_CTA_NOTE-->", () => note)
    .replace("<!--RRO_JSONLD-->", () => rroJsonLd(state))
    .replace("<!--RRO_FAQ_SECTION-->", () => rroFaqHtml());
  // The page varies on the preview cookie: never let a shared cache serve one visitor's variant to another.
  const extra = { "X-RRO-CTA": state, "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store", Vary: "Cookie" };
  const cookies = [];
  // The per-browser idempotency nonce is only issued where a checkout can actually start.
  const nonceCookie = state !== "hidden" && !rroBrowserNonce(request) ? rroNewBrowserNonceCookie() : null;
  if (state === "test_preview") {
    if (viaLink) {
      // Strip the token from the URL bar, history and Referer: 302 to /rro carrying the signed cookie.
      // SameSite=Lax so the cookie survives Stripe's top-level cancel redirect back to /rro.
      const cookie = await rroPreviewCookieFor(rroPreviewSecret(env), Date.now() / 1000);
      cookies.push(RRO_PREVIEW_COOKIE + "=" + cookie + "; Path=/; Max-Age=" + RRO_PREVIEW_TTL_SEC + "; Secure; HttpOnly; SameSite=Lax");
      if (nonceCookie) cookies.push(nonceCookie);
      extra.Location = "/rro";
      extra["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
      extra["X-Content-Type-Options"] = "nosniff";
      extra["X-Frame-Options"] = "DENY";
      return { redirect: true, html: "", headers: extra, cookies };
    }
  }
  if (nonceCookie) cookies.push(nonceCookie);
  return { html, headers: extra, cookies };
}
// --------------------------- end RRO checkout ---------------------------

export { rroHandleCheckoutRoutes, rroRenderRroPage, RRO_FAQ };
