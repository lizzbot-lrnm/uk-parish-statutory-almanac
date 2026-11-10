// node --test tests/  — P63 (money alerts never throttled), P64 (deploy refuses without a readable rollback
// target), P61 (deploy sets and verifies the Workers Logs privacy config; mismatch = stop + roll back). No network.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rroAlert, rroResetIsolateStateForTests, RRO_ALERT_EVENT, RRO_ALERT_UNTHROTTLED } from "../src/rro_core.js";
import { captureLogs } from "./rro_batch_helpers.mjs";

const alerts = (logs) => logs.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((j) => j && j.event === RRO_ALERT_EVENT);

// ---------------------------------------------------------------- P63
test("P63: webhook_record_failed, pack_record_failed and webhook_paid_row_missing are never throttled; others still are", async () => {
  rroResetIsolateStateForTests();
  assert.deepEqual([...RRO_ALERT_UNTHROTTLED].sort(), ["pack_record_failed", "webhook_paid_row_missing", "webhook_record_failed"]);
  const t0 = 1_800_000_000_000;
  const logs = await captureLogs(async () => {
    for (let i = 0; i < 5; i++) {
      for (const a of RRO_ALERT_UNTHROTTLED) assert.equal(rroAlert(a, { mode: "test" }, t0 + i), true);
      rroAlert("webhook_signature_failed", { mode: "test" }, t0 + i);
    }
  });
  const a = alerts(logs);
  for (const name of RRO_ALERT_UNTHROTTLED) assert.equal(a.filter((x) => x.alert === name).length, 5, name);
  assert.equal(a.filter((x) => x.alert === "webhook_signature_failed").length, 1);
  assert.ok(a.every((x) => x.suppressed === undefined || x.alert === "webhook_signature_failed"));
});
