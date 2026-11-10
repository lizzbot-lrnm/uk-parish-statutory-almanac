// node --test tests/  — pre-LIVE batch P39 (client error states, hash-based CSP + frame headers, one region rule).
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "../worker.js";
import {
  rroResetIsolateStateForTests,
  rroCleanInputs,
  rroWindowStartIso,
  RRO_PUBLIC_RATE_LIMIT,
  RRO_LOOKUP_RATE_LIMIT,
  RRO_STRIPE_LOOKUP_GLOBAL_CAP,
  RRO_NOT_PAID_CACHE_TTL_MS,
  RRO_CHECKOUT_SCHEMA,
} from "../src/rro_core.js";
import {
  ORIGIN,
  FAKE_KEY,
  FAKE_WHSEC,
  FAKE_PEPPER,
  IP,
  fakeD1,
  configuredEnv,
  disabledEnv,
  get,
  post,
  stripeCalls,
  mockStripe,
  noStripe,
  jsonResp,
  paidSession,
  seedStart,
  sign,
  webhookReq,
  counters,
  withNow,
  captureLogs,
  PUBLIC_CODES,
} from "./rro_batch_helpers.mjs";

// ---------------------------------------------------------------- P39 headers
const sha256b64 = (s) => "'sha256-" + crypto.createHash("sha256").update(s, "utf8").digest("base64") + "'";
for (const path of ["/rro", "/", "/rro/london"]) {
  test("P39: " + path + " has a hash-based CSP (no 'unsafe-inline' scripts) that allows exactly its inline script, plus frame headers", async () => {
    const r = await worker.fetch(get(path), disabledEnv());
    assert.equal(r.status, 200);
    const csp = r.headers.get("Content-Security-Policy");
    const html = await r.text();
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src "));
    assert.ok(scriptSrc, csp);
    assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval|\*/);
    const inline = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter((m) => !/type=/.test(m[1] || "")).map((m) => m[2]);
    for (const s of inline) assert.ok(scriptSrc.includes(sha256b64(s)), "hash for inline script present");
    assert.equal((scriptSrc.match(/'sha256-/g) || []).length, inline.length);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /script-src-attr 'none'/);
    assert.equal(r.headers.get("X-Frame-Options"), "DENY");
    assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  });
}
test("P39: script hashes come from the trusted template, not the response — the /rro CSP is identical in every CTA state and an extra body script is not allow-listed", async () => {
  const { rroHtmlCsp } = await import("../src/rro_core.js");
  const a = (await worker.fetch(get("/rro"), disabledEnv())).headers.get("Content-Security-Policy");
  const b = (await worker.fetch(get("/rro"), configuredEnv({ STRIPE_SECRET_KEY: "sk_live_" + "FAKE0123456789", RRO_STRIPE_LIVE_ENABLED: "true" }))).headers.get("Content-Security-Policy");
  assert.equal(a, b);
  const tmpl = "<p>x</p><script>trusted()</script>";
  const csp = await rroHtmlCsp(tmpl);
  assert.ok(csp.includes(sha256b64("trusted()")));
  assert.ok(!csp.includes(sha256b64("evil()")));
  assert.equal(((await rroHtmlCsp("")).match(/'sha256-/g) || []).length, 0);
});

test("P39: /rro has no inline event-handler attributes (they would be blocked by the CSP)", async () => {
  const html = await (await worker.fetch(get("/rro"), disabledEnv())).text();
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ""), /\son[a-z]+\s*=/i);
});

// ---------------------------------------------------------------- P39 client error states
async function loadRroScript(fetchImpl) {
  const html = await (await worker.fetch(get("/rro"), disabledEnv())).text();
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0];
  const els = new Map(); const listeners = new Map();
  const mk = (id) => ({ id, value: "", textContent: "", innerHTML: "", href: "", className: "", colSpan: 0, children: [], attrs: {},
    addEventListener(type, fn) { listeners.set(id + ":" + type, fn); }, appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = v; } });
  const el = (id) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); };
  const rejections = [];
  const onRej = (r) => rejections.push(r);
  process.on("unhandledRejection", onRej);
  const ctx = { document: { getElementById: el, createElement: (t) => mk(t) }, window: { location: { search: "" } },
    URL, URLSearchParams, JSON, Number, String, Array, Math, console, setTimeout, fetch: fetchImpl };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await new Promise((r) => setTimeout(r, 30));
  return { el, listeners, rejections, done: () => process.off("unhandledRejection", onRej) };
}
const allText = (node) => (node.textContent || "") + (node.children || []).map(allText).join("");

test("P39: network failure -> friendly search error, no unhandled rejection", async () => {
  const h = await loadRroScript(() => Promise.reject(new TypeError("Failed to fetch")));
  try {
    assert.match(allText(h.el("resultsBody")), /could not reach the server/);
    assert.equal(h.el("statCount").textContent, "—");
    await h.listeners.get("calcBtn:click")();
    assert.match(h.el("calcOutput").textContent, /could not reach the server/);
    await h.listeners.get("auditBtn:click")();
    assert.match(h.el("auditOutput").textContent, /could not reach the server/);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(h.rejections, []);
  } finally { h.done(); }
});

test("P39: an HTML 5xx page or a 429 -> friendly error states, no unhandled rejection", async () => {
  const html500 = () => Promise.resolve({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  const h = await loadRroScript(html500);
  try {
    assert.match(allText(h.el("resultsBody")), /temporarily unavailable/);
    await h.listeners.get("calcBtn:click")();
    assert.match(h.el("calcOutput").textContent, /temporarily unavailable/);
    assert.doesNotMatch(h.el("calcOutput").textContent, /Unexpected token/);
  } finally { h.done(); }
  const h2 = await loadRroScript(() => Promise.resolve({ ok: false, status: 429, json: async () => ({ status: "error", error: "RATE_LIMITED" }) }));
  try {
    assert.match(allText(h2.el("resultsBody")), /Too many requests/);
    await h2.listeners.get("calcBtn:click")();
    assert.match(h2.el("calcOutput").textContent, /Too many requests/);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...h.rejections, ...h2.rejections], []);
  } finally { h2.done(); }
});

test("P39: success path still renders (search stats + calculator output)", async () => {
  const ok = (u) => Promise.resolve({ ok: true, status: 200, json: async () => (String(u).startsWith("/api/rro-search")
    ? { stats: { total_matched: 2, median_award_pct: 60, mean_award_pct: 60.3, total_claimed_gbp: 1, total_awarded_gbp: 1 }, results: [] }
    : { calculation: { a: 1 }, schedule_markdown: "| x |" }) });
  const h = await loadRroScript(ok);
  try {
    assert.equal(h.el("statCount").textContent, 2);
    await h.listeners.get("calcBtn:click")();
    assert.match(h.el("calcOutput").textContent, /^\{/);
  } finally { h.done(); }
});

// ---------------------------------------------------------------- P39 region rule
test("P39: one region rule — unknown region is 'all' in both the pack path and the calculator; known regions any case", async () => {
  assert.equal(rroCleanInputs({ region: "WORFMARK" }).region, "all");
  assert.equal(rroCleanInputs({ region: "london" }).region, "London");
  assert.equal(rroCleanInputs({ region: " Northern " }).region, "Northern");
  assert.equal(rroCleanInputs({}).region, "London");
  assert.equal(rroCleanInputs({ region: "  " }).region, "London", "blank is London, as in the calculator");
  const blank = await (await worker.fetch(post("/api/rro-calculate", { region: "" }), disabledEnv())).json();
  const london = await (await worker.fetch(post("/api/rro-calculate", { region: "London" }), disabledEnv())).json();
  assert.deepEqual(blank.calculation, london.calculation);
  const calc = await (await worker.fetch(get("/api/rro-calculate?region=WORFMARK"), disabledEnv())).json();
  assert.equal(JSON.stringify(calc).includes("WORFMARK"), false);
});
