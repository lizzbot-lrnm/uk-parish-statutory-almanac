// node --test tests/  — /rro discoverability: head tags, JSON-LD, FAQ, official links, sitemap, robots, internal links.
// No network: globalThis.fetch fails the test on any call.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import worker from "../worker.js";
import { rroResetIsolateStateForTests } from "../src/rro_core.js";
import { RRO_FAQ } from "../src/rro_pages.js";

const ORIGIN = "https://parish.technoplusit.co.uk";
const CANON = ORIGIN + "/rro";
const TITLE = "Rent Repayment Order (RRO) tribunal precedents";
const DESC = "Search 281 published First-tier Tribunal Rent Repayment Order decisions. See the 60% median award and run a free calculator. Formal pack coming soon.";
const H1 = "Rent Repayment Order (RRO) tribunal precedent finder";
const FAKE_PEPPER = "unit-test-pepper-" + "not-a-real-secret-000";
const FAKE_PREVIEW_SECRET = "unit-test-preview-" + "secret-not-real-000000";
const FAKE_WHSEC = "whsec_" + "unit_test_only_not_a_real_secret";
const exp = Math.floor(Date.now() / 1000) + 3600;
const PREVIEW = { Cookie: "rro_preview=" + exp + "." + crypto.createHmac("sha256", FAKE_PREVIEW_SECRET).update("rro-preview-cookie-v1:" + exp).digest("hex") };
const GUIDE_TENANTS = "https://www.gov.uk/guidance/rent-repayment-orders-guidance-for-tenants";
const GUIDE_LA = "https://www.gov.uk/government/publications/rent-repayment-orders-guidance-for-local-authorities/rent-repayment-orders-guidance-for-local-authorities";
const FORM_RRO1 = "https://www.gov.uk/government/publications/apply-for-a-rent-repayment-order-form-rro1";

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
function baseEnv(over = {}) {
  rroResetIsolateStateForTests();
  return { RRO_IP_PEPPER: FAKE_PEPPER, RRO_PREVIEW_SECRET: FAKE_PREVIEW_SECRET, RRO_CHECKOUT_DB: fakeD1(), ...over };
}
function trapFetch() {
  globalThis.fetch = async (url) => { throw new Error("unexpected network call: " + url); };
}
const get = (path, headers = {}) => new Request(ORIGIN + path, { headers: { "CF-Connecting-IP": "203.0.113.7", ...headers } });
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'");
async function page(env, headers = {}) {
  trapFetch();
  const r = await worker.fetch(get("/rro", headers), env);
  assert.equal(r.status, 200);
  return { r, html: await r.text() };
}
function jsonLd(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1, "exactly one JSON-LD block");
  return JSON.parse(blocks[0]);
}
const offerOf = (ld) => ld["@graph"].find((n) => n["@type"] === "Product").offers;
const head = (html) => html.slice(0, html.indexOf("</head>"));

test("SEO head: title, meta description, canonical, Open Graph and Twitter tags; no 'Section 13'", async () => {
  const { html } = await page(baseEnv());
  const h = head(html);
  assert.equal(decode(h.match(/<title>([^<]*)<\/title>/)[1]), TITLE);
  assert.ok(TITLE.length <= 60);
  const desc = decode(h.match(/<meta name="description" content="([^"]*)"/)[1]);
  assert.equal(desc, DESC);
  assert.ok(desc.length <= 160);
  assert.match(h, /<link rel="canonical" href="https:\/\/parish\.technoplusit\.co\.uk\/rro" \/>/);
  const meta = (attr, key) => { const m = h.match(new RegExp('<meta ' + attr + '="' + key + '" content="([^"]*)"')); assert.ok(m, key); return decode(m[1]); };
  assert.equal(meta("property", "og:url"), CANON);
  assert.equal(meta("property", "og:type"), "website");
  assert.equal(meta("property", "og:locale"), "en_GB");
  assert.equal(meta("property", "og:title"), TITLE);
  assert.equal(meta("property", "og:description"), DESC);
  assert.equal(meta("name", "twitter:card"), "summary");
  assert.equal(meta("name", "twitter:title"), TITLE);
  assert.equal(meta("name", "twitter:description"), DESC);
  for (const d of [desc, meta("property", "og:description"), meta("name", "twitter:description"), jsonLd(html)["@graph"].find((n) => n["@type"] === "WebApplication").description]) {
    assert.doesNotMatch(d, /export a formal pack/i);
  }
  assert.equal(decode(html.match(/<h1>([^<]*)<\/h1>/)[1]), H1);
  assert.doesNotMatch(h, /Section 13\b/);
  assert.doesNotMatch(html.match(/<h1>[^<]*<\/h1>/)[0], /Section 13\b/);
});

test("SEO copy: audience is tenants and local housing authorities (s.41), not parish councils; not-legal-advice near hero and CTA", async () => {
  const { html } = await page(baseEnv());
  const aud = html.match(/<p class="audience" id="rroAudience">([\s\S]*?)<\/p>/)[1];
  assert.match(aud, /A tenant, or a local housing authority, can apply/);
  assert.match(aud, /Housing and Planning Act 2016 s\.41/);
  assert.match(aud, /Parish and town councils cannot\./);
  assert.match(aud, /not legal advice/i);
  assert.match(html.match(/<p class="subtitle">([\s\S]*?)<\/p>/)[1], /tenants, tenant advisers, and local housing authority/);
  assert.match(html.match(/id="formalPackComingSoon"[^>]*>([^<]*)</)[1], /not legal advice/i);
  assert.doesNotMatch(html, /Zero-token deterministic index/);
});

test("SEO links: GOV.UK guidance (tenants + local authorities), Form RRO1, OGL and /llms.txt are linked over HTTPS; no /rro/stats link", async () => {
  const { html } = await page(baseEnv());
  for (const u of [GUIDE_TENANTS, GUIDE_LA, FORM_RRO1, "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"]) {
    assert.ok(html.includes('href="' + u + '"'), u);
  }
  for (const p of ["/", "/llms.txt", "/api/rro-search?format=csv"]) assert.ok(html.includes('href="' + p + '"'), p);
  assert.ok(!html.includes('href="/rro/stats"'));
  for (const p of ["/llms.txt", "/api/rro-search?format=csv", "/"]) {
    assert.equal((await worker.fetch(get(p), baseEnv())).status, 200, p);
  }
});

test("JSON-LD parses; FAQPage matches the visible FAQ word-for-word; Product/Offer is £24 GBP", async () => {
  const { html } = await page(baseEnv());
  const ld = jsonLd(html);
  assert.equal(ld["@context"], "https://schema.org");
  const types = ld["@graph"].map((n) => n["@type"]);
  for (const t of ["WebApplication", "Product", "FAQPage", "Dataset"]) assert.ok(types.includes(t), t);
  const app = ld["@graph"].find((n) => n["@type"] === "WebApplication");
  assert.equal(app.url, CANON);
  assert.equal(app.description, DESC);
  assert.equal(app.isAccessibleForFree, true);
  const product = ld["@graph"].find((n) => n["@type"] === "Product");
  assert.equal(product.name, "Export Formal Tribunal Appeal Pack");
  const offer = product.offers;
  assert.equal(offer["@type"], "Offer");
  assert.equal(Number(offer.price), 24);
  assert.equal(offer.priceCurrency, "GBP");
  const faq = ld["@graph"].find((n) => n["@type"] === "FAQPage");
  assert.equal(faq.mainEntity.length, RRO_FAQ.length);
  assert.ok(RRO_FAQ.length >= 6);
  const visible = html.match(/<div class="card faq" id="rro-faq">([\s\S]*?)<\/dl>/)[1];
  const dts = [...visible.matchAll(/<dt>([\s\S]*?)<\/dt>/g)].map((m) => decode(m[1]));
  const dds = [...visible.matchAll(/<dd>([\s\S]*?)<\/dd>/g)].map((m) => decode(m[1]));
  faq.mainEntity.forEach((q, i) => {
    assert.equal(q["@type"], "Question");
    assert.equal(q.name, dts[i]);
    assert.equal(q.acceptedAnswer.text, dds[i]);
  });
  assert.match(dds[1], /not parish or town councils/);
  assert.ok(!/<\/script/i.test(JSON.stringify(ld)));
});

const NOT_LIVE = [
  ["no Stripe env (production today)", {}, {}],
  ["sk_test_ without preview", { STRIPE_SECRET_KEY: "sk_test_" + "FAKEFAKEFAKE0123456789", STRIPE_WEBHOOK_SECRET: FAKE_WHSEC }, {}],
  ["sk_test_ with preview", { STRIPE_SECRET_KEY: "sk_test_" + "FAKEFAKEFAKE0123456789", STRIPE_WEBHOOK_SECRET: FAKE_WHSEC }, PREVIEW],
  ["live key without RRO_STRIPE_LIVE_ENABLED", { STRIPE_SECRET_KEY: "sk_live_" + "FAKE0123456789", STRIPE_WEBHOOK_SECRET: FAKE_WHSEC }, {}],
];
for (const [label, over, headers] of NOT_LIVE) {
  test("JSON-LD offer is never InStock unless the live CTA is shown (" + label + ")", async () => {
    const { r, html } = await page(baseEnv(over), headers);
    assert.notEqual(r.headers.get("X-RRO-CTA"), "live");
    const offer = offerOf(jsonLd(html));
    assert.notEqual(offer.availability, "https://schema.org/InStock");
    assert.equal(offer.availability, "https://schema.org/OutOfStock");
    assert.doesNotMatch(html, /InStock/);
  });
}

test("disabled state unchanged by SEO work: X-RRO-CTA hidden, no buy button, checkout 503, old £29 path 404", async () => {
  const e = baseEnv();
  const { r, html } = await page(e);
  assert.equal(r.headers.get("X-RRO-CTA"), "hidden");
  assert.doesNotMatch(html, /id="formalPackBtn"/);
  assert.doesNotMatch(html, /£29/);
  trapFetch();
  const c = await worker.fetch(new Request(ORIGIN + "/api/rro/checkout", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify({ region: "London", monthly_rent_gbp: 1800, months_unlicensed: 12 }),
  }), e);
  assert.equal(c.status, 503);
  assert.equal((await worker.fetch(get("/rro/buy-pack"), baseEnv())).status, 404);
});

test("live state (both gates): offer flips to InStock, CTA label exact", async () => {
  const { r, html } = await page(baseEnv({ STRIPE_SECRET_KEY: "sk_live_" + "FAKE0123456789", STRIPE_WEBHOOK_SECRET: FAKE_WHSEC, RRO_STRIPE_LIVE_ENABLED: "true" }));
  assert.equal(r.headers.get("X-RRO-CTA"), "live");
  assert.match(html, />Export Formal Tribunal Appeal Pack — £24<\/button>/);
  assert.equal(offerOf(jsonLd(html)).availability, "https://schema.org/InStock");
});

test("on-page and structured-data stats match the index behind /api/rro-search (no stale hard-coded figures)", async () => {
  trapFetch();
  const st = (await (await worker.fetch(get("/api/rro-search"), baseEnv())).json()).stats;
  const { html } = await page(baseEnv());
  const gbp = (v) => "£" + Math.round(v).toLocaleString("en-GB");
  assert.match(html, new RegExp('id="statCount">' + st.total_matched + "<"));
  assert.match(html, new RegExp('id="statMedian">' + st.median_award_pct + "%<"));
  assert.match(html, new RegExp('id="statMean">' + st.mean_award_pct + "%<"));
  assert.ok(html.includes('id="statClaimed">' + gbp(st.total_claimed_gbp) + "<"));
  assert.ok(html.includes('id="statAwarded">' + gbp(st.total_awarded_gbp) + "<"));
  const ld = jsonLd(html);
  const faqText = ld["@graph"].find((n) => n["@type"] === "FAQPage").mainEntity.map((q) => q.acceptedAnswer.text).join(" ");
  assert.ok(faqText.includes("index of " + st.total_indexed_rulings + " published decisions"));
  assert.ok(faqText.includes("is " + st.median_award_pct + "% and the mean is " + st.mean_award_pct + "%"));
  for (const d of [DESC, ld["@graph"].find((n) => n["@type"] === "Dataset").description]) {
    assert.ok(d.includes(String(st.total_indexed_rulings)), d);
  }
  assert.ok(DESC.includes(st.median_award_pct + "% median"));
  const ds = ld["@graph"].find((n) => n["@type"] === "Dataset");
  assert.doesNotMatch(JSON.stringify(ds.creator), /HMCTS|Courts|GOV\.UK/i, "the index is not presented as an official dataset");
});

test("sitemap.xml lists /rro (not /rro/stats) and robots.txt allows /rro and points at the sitemap", async () => {
  trapFetch();
  const sm = await worker.fetch(get("/sitemap.xml"), baseEnv());
  assert.equal(sm.status, 200);
  assert.match(sm.headers.get("Content-Type"), /application\/xml/);
  const xml = await sm.text();
  assert.ok(xml.includes("<loc>https://parish.technoplusit.co.uk/rro</loc>"));
  assert.ok(!xml.includes("/rro/stats"));
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.equal((xml.match(/<url>/g) || []).length, (xml.match(/<\/url>/g) || []).length);
  const rb = await worker.fetch(get("/robots.txt"), baseEnv());
  assert.equal(rb.status, 200);
  const txt = await rb.text();
  assert.match(txt, /^Allow: \/rro$/m);
  assert.doesNotMatch(txt, /^Disallow: \/rro/m);
  assert.match(txt, /^Sitemap: https:\/\/parish\.technoplusit\.co\.uk\/sitemap\.xml$/m);
});

test("internal links: almanac home links to /rro (no 'Section 13'), and a regional page links back to /rro", async () => {
  trapFetch();
  const home = await (await worker.fetch(get("/"), baseEnv())).text();
  const links = [...home.matchAll(/<a href="\/rro"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
  assert.ok(links.length >= 2, "home links to /rro at least twice");
  for (const l of links) assert.doesNotMatch(l, /Section 13\b/);
  assert.match(home, /not parish or town councils/);
  const llms = await (await worker.fetch(get("/llms.txt"), baseEnv())).text();
  assert.doesNotMatch(llms, /Section 13\b/);
  const region = await worker.fetch(get("/rro/london"), baseEnv());
  assert.equal(region.status, 200);
  assert.match(await region.text(), /href="\/rro"/);
});
