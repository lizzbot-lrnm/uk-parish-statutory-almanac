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
