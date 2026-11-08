# £24 "Export Formal Tribunal Appeal Pack" (Stripe Checkout on /rro)

Product approved by the site owner with the Day-7 kill rule below.
Scope: one product only (no other live-money products). Hosted Stripe Checkout redirect (no Stripe.js / Elements).

## Routes (Worker `parish-statutory-almanac`, host `parish.technoplusit.co.uk`)
| Route | Purpose |
|---|---|
| `POST /api/rro/checkout` | Same-origin only (Origin check). **Test mode: preview cookie required** (see T1). Creates a £24.00 GBP Checkout Session, records a `checkout_start`, returns `{url}` (or 303 for form posts). Rate limit 5 attempts / 10 min per peppered IP hash, slot reserved **before** the Stripe call (failed calls count). |
| `POST /api/rro/stripe-webhook` | Verifies `Stripe-Signature` (HMAC-SHA256, 300 s tolerance, constant-time compare). On `checkout.session.completed` / `checkout.session.async_payment_succeeded` for a paid £24 pack session → records `paid` (idempotent on session id). |
| `GET /rro/pack/success?session_id=cs_…` | D1-first (T2): unknown session id → 404, no Stripe call. Then paid-verdict cache (≤10 min), then Stripe re-verify (paid, £24 GBP, product key); records `paid` idempotently (webhook backup), shows download links. |
| `GET /api/rro/pack?session_id=cs_…&format=md\|csv` | Same D1-first / cache / Stripe order. Paid-session-gated download of the formal pack (valid 30 days from purchase). Success + pack lookups share a 30 / 10 min per-ip_hash limit (429). |
| `GET /api/rro/telemetry` | **Public (CORS \*)**: `{status, product, price_gbp, mode}` (`product` is the generic id `tribunal_appeal_pack`) only, where `mode` is `test` / `live` / `unavailable` (T5). **Full** counters (`checkout_starts, paid, since, stripe_mode, by_mode, day7_kill_rule`) only with `Authorization: Bearer <RRO_TELEMETRY_TOKEN>` (no CORS). |

## Day-7 falsification rule
Clock starts at `RRO_CHECKOUT_LIVE_SINCE` (set when **live** keys go on — test mode does not start the clock).
At `since + 7 days`: **`checkout_starts < 10` OR `paid == 0` → KILL** (remove CTA, disable routes).
`/api/rro/telemetry` reports `day7_kill_rule.verdict`: `clock_not_started` → `running_below_threshold` / `running_threshold_met` → `KILL` / `SURVIVES`.

## Configuration (names only — never commit or paste values)
| Name | Kind | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | Worker secret | `sk_test_…`/`rk_test_…` first. A live key is **refused** unless `RRO_STRIPE_LIVE_ENABLED=true`. A restricted key needs Checkout Sessions: write. |
| `STRIPE_WEBHOOK_SECRET` | Worker secret | `whsec_…` from the Stripe webhook endpoint below. Checkout fails closed without it. |
| `RRO_IP_PEPPER` | Worker secret | **Required** (T3). Dedicated HMAC pepper for `ip_hash` (≥16 chars, must not equal the whsec). Checkout and pack lookups return `503 CHECKOUT_NOT_CONFIGURED` without it. Generate locally and put it directly: `openssl rand -hex 32 \| wrangler secret put RRO_IP_PEPPER --name parish-statutory-almanac` (never echo/paste the value). |
| `RRO_TELEMETRY_TOKEN` | Worker secret | Optional bearer for full telemetry (≥24 chars). Unset → only the minimal public view exists. Same `openssl rand -hex 32 \| wrangler secret put …` pattern. |
| `RRO_STRIPE_LIVE_ENABLED` | plain var | Exactly `true` (case-sensitive, no whitespace; T4) **only after the live-mode security review passes and the site owner approves**. `TRUE`, `True`, `1` stay blocked. |
| `RRO_CHECKOUT_LIVE_SINCE` | plain var | ISO-8601 UTC, set at live launch (Day-7 clock). |
| `RRO_CHECKOUT_DB` | D1 binding | Dedicated DB `parish-rro-checkout`; schema in `migrations/0001_rro_checkout_events.sql` (also auto-created). |

Stripe webhook endpoint: `https://parish.technoplusit.co.uk/api/rro/stripe-webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`.

## Fail-closed behaviour
Missing key / webhook secret / D1 / `RRO_IP_PEPPER`, or live key without the exact flag → `503 {"error":"CHECKOUT_NOT_CONFIGURED"}` with **no `detail`** (T5); Stripe is never called. Stripe returning a non-`checkout.stripe.com` URL → 502 (no open redirect); Stripe create failures return a generic `STRIPE_SESSION_CREATE_FAILED` with no upstream status.

## T1: /rro CTA in test mode (production site)
| State | What /rro shows |
|---|---|
| Live (exact flag + live key + security review + owner approval) | Normal "Export Formal Tribunal Appeal Pack — £24" CTA |
| Test key, visitor has preview | Amber "[TEST MODE] …" button plus banner **"TEST MODE – no real payment; do not enter real card details."** Stripe Checkout also shows that text above the pay button (`custom_text[submit]`). |
| Test key, no preview / not configured | **No CTA at all.** Real visitors never reach a Stripe test checkout. |

Preview: open `https://parish.technoplusit.co.uk/rro?rro_preview=1`. That sets an `HttpOnly; Secure; SameSite=Strict` cookie `rro_preview=1` for 24h. `POST /api/rro/checkout` in test mode also requires that cookie (503 without it). Preview responses are `Cache-Control: private, no-store`; header `X-RRO-CTA` reports `live` / `test_preview` / `hidden`.

## T3: IP hash retention
`ip_hash = HMAC-SHA256(RRO_IP_PEPPER, YYYY-MM-DD + ":" + CF-Connecting-IP)` truncated to 32 hex. Event-row `ip_hash` is set to NULL after **48h** and rate-limit rows are deleted after 1h. This runs on every checkout/lookup write, and from `scheduled()` if you add a cron trigger (optional, e.g. hourly: Workers → parish-statutory-almanac → Settings → Triggers → Cron).

## Base branch
Targets `main` directly; contains only the checkout change.

## Live gate checklist (not in this pass)
All must be done, plus a fresh security review, owner approval and a separate live webhook secret, before `RRO_STRIPE_LIVE_ENABLED` is set. Marked `TODO(live-gate L1–L10)` in worker.js.
- [ ] L1 Trader identity shown before purchase
- [ ] L2 Terms of sale and refund policy
- [ ] L3 Consumer Contracts Regulations reg. 37 digital-content waiver
- [ ] L4 Privacy notice
- [ ] L5 Pre-purchase "not legal advice" notice
- [ ] L6 Product rename review
- [ ] L7 Note that the underlying OGL data is free
- [ ] L8 Estimate wording review
- [ ] L9 Remove the legacy £29 intent-validation offer (`/api/rro/buy-pack`)
- [ ] L10 Day-7 rule counts paid orders only and has a named owner

## Deploy
1. `node deploy/build_cf_execute.mjs > deploy_payload.js` — produces the Cloudflare-API `execute` payload (creates/reuses D1 `parish-rro-checkout`, uploads `worker.js` with the D1 binding and `keep_bindings: ["secret_text"]` so secrets survive redeploys).
2. Secrets are put by the key holder (`wrangler secret put STRIPE_SECRET_KEY --name parish-statutory-almanac`, same for `STRIPE_WEBHOOK_SECRET`), plus `RRO_IP_PEPPER` (required) and optionally `RRO_TELEMETRY_TOKEN` via the `openssl rand -hex 32 | wrangler secret put …` pattern, or the CF dashboard. Never echo values in chat, notes, logs or commits.
3. Smoke: `curl https://parish.technoplusit.co.uk/api/rro/telemetry` → `{"status":"ok",…,"mode":"test"}`. `/rro` without preview → no CTA (`X-RRO-CTA: hidden`). `/rro?rro_preview=1` → TEST MODE CTA. From that preview browser, pay with a Stripe test card (4242…), then check `paid` increments via full telemetry (bearer).

## Tests
`node --test tests/rro_checkout.test.mjs` (Node ≥ 22, uses `node:sqlite` as a D1 stand-in; Stripe is mocked).
