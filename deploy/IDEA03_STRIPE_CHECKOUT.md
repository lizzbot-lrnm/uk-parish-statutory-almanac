# IDEA-03 SHAPE-O1 — £24 "Export Formal Tribunal Appeal Pack" (Stripe Checkout on /rro)

Greenlit by Lewis, 2026-11-05 11:00 GMT: *"Yes, greenlight the £24 Stripe checkout on /rro with the Day-7 kill rule"*.
Scope: one product only (no other live-money products). Hosted Stripe Checkout redirect (no Stripe.js / Elements).

## Routes (Worker `parish-statutory-almanac`, host `parish.technoplusit.co.uk`)
| Route | Purpose |
|---|---|
| `POST /api/rro/checkout` | Same-origin only (Origin check). Creates a £24.00 GBP Checkout Session, records a `checkout_start`, returns `{url}` (or 303 for form posts). Rate limit 5 starts / 10 min per salted IP hash. |
| `POST /api/rro/stripe-webhook` | Verifies `Stripe-Signature` (HMAC-SHA256, 300 s tolerance, constant-time compare). On `checkout.session.completed` / `checkout.session.async_payment_succeeded` for a paid £24 pack session → records `paid` (idempotent on session id). |
| `GET /rro/pack/success?session_id=cs_…` | Re-verifies the session with Stripe (paid, £24 GBP, product key), records `paid` idempotently (webhook backup), shows download links. |
| `GET /api/rro/pack?session_id=cs_…&format=md\|csv` | Paid-session-gated download of the formal pack (valid 30 days from purchase). |
| `GET /api/rro/telemetry` | Public, read-only counters: `{checkout_starts, paid, since, stripe_mode, by_mode, day7_kill_rule}`. No secrets, no PII. |

## Day-7 falsification rule
Clock starts at `RRO_CHECKOUT_LIVE_SINCE` (set when **live** keys go on — test mode does not start the clock).
At `since + 7 days`: **`checkout_starts < 10` OR `paid == 0` → KILL** (remove CTA, disable routes).
`/api/rro/telemetry` reports `day7_kill_rule.verdict`: `clock_not_started` → `running_below_threshold` / `running_threshold_met` → `KILL` / `SURVIVES`.

## Configuration (names only — never commit or paste values)
| Name | Kind | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | Worker secret | `sk_test_…`/`rk_test_…` first. A live key is **refused** unless `RRO_STRIPE_LIVE_ENABLED=true`. A restricted key needs Checkout Sessions: write. |
| `STRIPE_WEBHOOK_SECRET` | Worker secret | `whsec_…` from the Stripe webhook endpoint below. Checkout fails closed without it. |
| `RRO_STRIPE_LIVE_ENABLED` | plain var | Set to `true` **only after Worf clears live mode**. |
| `RRO_CHECKOUT_LIVE_SINCE` | plain var | ISO-8601 UTC, set at live launch (Day-7 clock). |
| `RRO_CHECKOUT_DB` | D1 binding | Dedicated DB `parish-rro-checkout`; schema in `migrations/0001_rro_checkout_events.sql` (also auto-created). |

Stripe webhook endpoint: `https://parish.technoplusit.co.uk/api/rro/stripe-webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`.

## Fail-closed behaviour
Missing key / webhook secret / D1 → `503 CHECKOUT_NOT_CONFIGURED` and the CTA shows "temporarily unavailable"; Stripe is never called.
Live key without the Worf flag → 503. Stripe returning a non-`checkout.stripe.com` URL → 502 (no open redirect).

## Deploy
1. `node deploy/build_cf_execute.mjs > /workspace/agent-tools/deploy_parish_idea03.js` — produces the Cloudflare-API `execute` payload (creates/reuses D1 `parish-rro-checkout`, uploads `worker.js` with the D1 binding and `keep_bindings: ["secret_text"]` so secrets survive redeploys).
2. Secrets are put by the key holder (`wrangler secret put STRIPE_SECRET_KEY --name parish-statutory-almanac`, same for `STRIPE_WEBHOOK_SECRET`) or the CF dashboard. Never echo values in chat or notes.
3. Smoke: `curl https://parish.technoplusit.co.uk/api/rro/telemetry`; `POST /api/rro/checkout` with `Origin: https://parish.technoplusit.co.uk` → `url` on `checkout.stripe.com`; pay with Stripe test card in test mode; check `paid` increments.

## Tests
`node --test tests/rro_checkout.test.mjs` (Node ≥ 22, uses `node:sqlite` as a D1 stand-in; Stripe is mocked).
