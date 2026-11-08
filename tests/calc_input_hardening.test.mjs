// node --test tests/  — input hardening for the statutory calculators (no network; gov.uk is mocked).
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const ORIGIN = "https://parish.technoplusit.co.uk";
const get = (path) => new Request(ORIGIN + path);
const realFetch = globalThis.fetch;
const BH = { "england-and-wales": { events: [{ date: "2026-12-28", title: "Boxing Day (substitute day)" }] } };
const mockGovUk = (resp) => {
  globalThis.fetch = async () => resp();
};
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("calcS137AndGpc: explicit 0 seats is clamped to 1, not replaced by the 11-seat default", async () => {
  const zero = await (await worker.fetch(get("/api/s137-gpc?electors=1000&seats=0&elected=0&spend=0"), {})).json();
  assert.equal(zero.gpc_assessment.total_councillor_seats, 1);
  const none = await (await worker.fetch(get("/api/s137-gpc?electors=1000&elected=0&spend=0"), {})).json();
  assert.equal(none.gpc_assessment.total_councillor_seats, 11);
  assert.equal(none.s137_annual_cap_gbp, 11600);
});

test("calcHmrcBikCap: explicit personal_allowance=0 is honoured (not coerced to 12570)", async () => {
  const q = "/api/hmrc-bik-cap?cash_salary=18000&bik=36000&periods=12";
  const def = await (await worker.fetch(get(q), {})).json();
  const zero = await (await worker.fetch(get(q + "&personal_allowance=0"), {})).json();
  assert.notDeepEqual(zero, def, "PA=0 must change the result versus the 12570 default");
});

test("fetchBankHolidays: non-OK gov.uk response -> 502 BANK_HOLIDAYS_UNAVAILABLE, no silent empty map", async () => {
  mockGovUk(() => new Response("upstream down", { status: 503 }));
  const r = await worker.fetch(get("/api/three-clear-days?meeting=2026-11-16"), {});
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { status: "error", error: "BANK_HOLIDAYS_UNAVAILABLE" });
  mockGovUk(() => new Response("<html>not json</html>", { status: 200 }));
  const r2 = await worker.fetch(get("/api/three-clear-days?meeting=2026-11-16"), {});
  assert.equal(r2.status, 502);
});

test("calcThreeClearDays: malformed meeting date -> 400 INVALID_MEETING_DATE (no RangeError)", async () => {
  mockGovUk(() => Response.json(BH));
  for (const bad of ["2026-13-01", "16/11/2026", "2026-02-30", "x"]) {
    const r = await worker.fetch(get("/api/three-clear-days?meeting=" + encodeURIComponent(bad)), {});
    assert.equal(r.status, 400, bad);
    assert.equal((await r.json()).error, "INVALID_MEETING_DATE");
  }
  const ok = await worker.fetch(get("/api/three-clear-days?meeting=2026-11-16"), {});
  assert.equal(ok.status, 200);
});

test("calcThreeClearDays: rollback loop also skips 25 December", async () => {
  mockGovUk(() => Response.json(BH));
  // Meeting Wed 30 Dec 2026: clear days 29, (28 BH), (27 Sun), 26 Sat?, ... publish date must never be 12-25.
  for (const m of ["2026-12-29", "2026-12-30", "2026-12-31"]) {
    const body = await (await worker.fetch(get("/api/three-clear-days?meeting=" + m), {})).json();
    assert.doesNotMatch(JSON.stringify(body).match(/"latest_publish_date":"[^"]+"/g).join(","), /-12-25/, m);
  }
});

test("calcHmrcBikCap: 45% additional rate only on taxable income over £125,140 (HMRC rUK 2026/27, PA taper)", async () => {
  // Expected annual tax: 20% on 37,700 + 40% to 125,140 taxable + 45% above; PA tapers £1 per £2 over £100k.
  const expected = { 100000: 27432, 116800: 37512, 120000: 39432, 130000: 44703 };
  for (const [gross, tax] of Object.entries(expected)) {
    const j = await (await worker.fetch(get("/api/hmrc-bik-cap?cash_salary=" + gross + "&bik=0&periods=12"), {})).json();
    const annual = j.per_period_summary.cash_only_tax_per_period_gbp * 12;
    assert.ok(Math.abs(annual - tax) < 1, gross + ": got " + annual + ", want " + tax);
  }
});

test("fetchBankHolidays: a network error from gov.uk gives 502 BANK_HOLIDAYS_UNAVAILABLE, not a crash", async () => {
  globalThis.fetch = async () => { throw new TypeError("network down"); };
  const r = await worker.fetch(get("/api/three-clear-days?meeting=2026-11-16"), {});
  assert.equal(r.status, 502);
  assert.equal((await r.json()).error, "BANK_HOLIDAYS_UNAVAILABLE");
});

test("/api/almanac: malformed commencement or year is a 400 before any upstream fetch", async () => {
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return new Response(JSON.stringify(BH)); };
  for (const q of ["commencement=2026-99-01", "year=99999", "meeting=nope"]) {
    const r = await worker.fetch(get("/api/almanac?" + q), {});
    assert.equal(r.status, 400, q);
  }
  assert.equal(fetched, false);
});
