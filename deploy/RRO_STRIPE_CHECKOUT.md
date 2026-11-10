# £24 "Export Formal Tribunal Application Pack" (Stripe Checkout on /rro)

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
| `STRIPE_WEBHOOK_SECRET` | Worker secret | `whsec_…` from the Stripe webhook endpoint below. Leading/trailing whitespace or a newline is trimmed (as for `STRIPE_SECRET_KEY`); it must then be `whsec_`-shaped (`whsec_` + at least 16 of `A-Za-z0-9_+/=-`); anything else counts as missing. Checkout fails closed without it. |
| `RRO_PREVIEW_SECRET` | Worker secret | **Required for test preview.** HMAC key for the preview link token and cookie (≥24 chars). Missing → preview disabled (fail closed). |
| `RRO_IP_PEPPER` | Worker secret | **Required** (T3). Dedicated HMAC pepper for `ip_hash` (≥16 chars, must not equal the whsec). Without it, checkout returns `503 CHECKOUT_NOT_CONFIGURED`, while `/api/rro/pack` and `/rro/pack/success` return the generic `503 UNAVAILABLE` (P16; the internal reason is logged only). Generate locally and put it directly: `openssl rand -hex 32 \| wrangler secret put RRO_IP_PEPPER --name parish-statutory-almanac` (never echo/paste the value). |
| `RRO_CHECKOUT_DAILY_CAP` | Plain var (optional) | P53: global ceiling on **new** Stripe Checkout sessions per UTC day, all IPs together. The default is **50** new checkout sessions per UTC day (`RRO_CHECKOUT_DAILY_CAP_DEFAULT` in `src/rro_core.js`). Set an integer from 1 to 10000 to raise it; anything else falls back to 50, never to unlimited. Over the cap, or on a counter error, checkout returns a generic `503 CHECKOUT_UNAVAILABLE` and Stripe is not called. Paid buyers' pack and success lookups never touch it. |
| `RRO_TELEMETRY_TOKEN` | Worker secret | Optional bearer for full telemetry (≥24 chars). Unset → only the minimal public view exists. Same `openssl rand -hex 32 \| wrangler secret put …` pattern. |
| `RRO_STRIPE_LIVE_ENABLED` | plain var | Exactly `true` (case-sensitive, no whitespace; T4) **only after the live-mode security review passes and the site owner approves**. `TRUE`, `True`, `1` stay blocked. |
| `RRO_CHECKOUT_LIVE_SINCE` | plain var | ISO-8601 UTC, set at live launch (Day-7 clock). |
| `RRO_CHECKOUT_DB` | D1 binding | Dedicated DB `parish-rro-checkout`; schema in `migrations/0001_rro_checkout_events.sql` (also auto-created). |

Stripe webhook endpoint: `https://parish.technoplusit.co.uk/api/rro/stripe-webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`.

## Fail-closed behaviour
The Stripe webhook likewise returns `503 {"error":"WEBHOOK_NOT_CONFIGURED"}` and writes nothing unless both `STRIPE_SECRET_KEY` (usable: test, or live with the flag) and `STRIPE_WEBHOOK_SECRET` are set. Missing key / webhook secret / D1 / `RRO_IP_PEPPER`, or live key without the exact flag → `503 {"error":"CHECKOUT_NOT_CONFIGURED"}` on checkout with **no `detail`** (T5); Stripe is never called. Stripe returning a non-`checkout.stripe.com` URL, or any Stripe create failure → `502 {"error":"CHECKOUT_UNAVAILABLE"}` (no open redirect, no upstream status or message; the internal reason is logged).

**P16 public error codes.** `/api/rro/pack` and `/rro/pack/success` only ever return `INVALID_REQUEST` (400), `PAYMENT_NOT_COMPLETE` (402), `NOT_FOUND` (404, including a session id for the other key mode), `NOT_AVAILABLE` (410), `RATE_LIMITED` (429 + `Retry-After`) or `UNAVAILABLE` (502/503, including "not configured"). The internal code (`CHECKOUT_NOT_CONFIGURED`, `SESSION_MODE_MISMATCH`, `DOWNLOAD_EXPIRED`, …) goes to the Worker log only, without the session id. Any unexpected exception returns a generic no-store `500 {"error":"INTERNAL_ERROR"}`, and the message is logged.

## T1: /rro CTA in test mode (production site)
| State | What /rro shows |
|---|---|
| Live (exact flag + live key + security review + owner approval) | Normal "Export Formal Tribunal Application Pack — £24" CTA |
| Test key, visitor has preview | Amber "[TEST MODE] …" button plus banner **"TEST MODE – no real payment; do not enter real card details."** Stripe Checkout also shows that text above the pay button (`custom_text[submit]`). |
| Test key, no preview / not configured | **No CTA at all**, only the plain text "Formal Tribunal Application Pack (£24): checkout coming soon." (no button, no link, no Stripe call; `X-RRO-CTA: hidden`). Real visitors never reach a Stripe test checkout. |

Preview (signed, key holder only): the link token is `<exp>.<HMAC-SHA256(RRO_PREVIEW_SECRET, "rro-preview-link-v2:" + exp)>` (hex), where `exp` is a unix time no more than 24h ahead; the expiry is inside the HMAC, so it can't be extended. Compute it locally with `exp=$(( $(date +%s) + 86400 )); echo "$exp.$(printf 'rro-preview-link-v2:%s' "$exp" | openssl dgst -sha256 -hmac "$RRO_PREVIEW_SECRET" | awk '{print $NF}')"` (never paste the secret or token in chat, notes or logs). Expired links, links more than 24h ahead and the old static v1 token are refused. The Worker never logs the token; Cloudflare's own request logs can still record the query string, which is why the link expires. Opening `/rro?rro_preview=<token>` returns a 302 to `/rro` (so the token leaves the URL bar, history and Referer; `Referrer-Policy: no-referrer` on `/rro`) and sets an `HttpOnly; Secure; SameSite=Lax` cookie (Lax so it survives Stripe's cancel redirect back to `/rro`; the checkout POST is still Origin-checked) `rro_preview=<exp>.<HMAC(secret, "rro-preview-cookie-v1:"+exp)>` valid 24h. Unsigned, forged, expired or wrong-key cookies are ignored, and if `RRO_PREVIEW_SECRET` is missing (or under 24 chars) preview fails closed: no CTA and `POST /api/rro/checkout` in test mode returns 503. Preview responses are `Cache-Control: private, no-store`; header `X-RRO-CTA` reports `live` / `test_preview` / `hidden`.

## T3: IP hash retention
`ip_hash = HMAC-SHA256(RRO_IP_PEPPER, YYYY-MM-DD + ":" + CF-Connecting-IP)` truncated to 32 hex. Event-row `ip_hash` is set to NULL after **48h** and rate-limit rows are deleted after 1h. The full purge runs from `scheduled()` on a **mandatory hourly cron** (`0 * * * *`, the API equivalent of wrangler `[triggers] crons`), which `deploy/build_cf_execute.mjs` registers (keeping any existing crons) and then reads back, failing the deploy if it is missing. It also runs on admitted checkout writes, and every webhook write runs a bounded purge (at most 500 rows per table). Pack/success lookups check the session id format (`cs_test_`/`cs_live_` + 10–240 alphanumerics) before anything else. Their per-`ip_hash` limit (30 per 10 minutes) is first a fixed-window pre-filter held in isolate memory and in `caches.default` under `__rro_internal_cache/v1/rl/`, which costs no D1 write. A lookup of an id that D1 doesn't know ends there with a 404 and **no D1 write**. Only a lookup of a known session also counts on the global D1 counter (`rro_rate_counters`, bucket `pack_lookup`, P3). That is one conditional upsert, and nothing is written once the limit is reached. A Stripe GET for a session not yet recorded as paid also counts once on that session's `stripe_lookup_session` budget, and once on the global `stripe_lookup` ceiling (P2/P41). A verified-paid lookup may also record `paid`, as before. Rate-limit keys bucket IPv6 by /64.

## Base branch
The base branch is **`main`**. PR [#2](https://github.com/lizzbot-lrnm/uk-parish-statutory-almanac/pull/2) (`daneel/rro-checkout-test`) targets `main` directly and contains only the checkout change; it supersedes PR #1 (`feat/idea03-stripe-checkout`), which is not a base for anything. Local checkouts should track `origin/daneel/rro-checkout-test` (`git branch --set-upstream-to=origin/daneel/rro-checkout-test`) and be compared against `origin/main`.

## TC2: rate-hit purge index
`ix_rro_rate_hits_created_at ON rro_rate_hits(created_at_utc)` is in `migrations/0002_rro_rate_hits_created_at.sql` and the lazy schema, so the retention `DELETE … WHERE created_at_utc < ?` (full and bounded) uses an index instead of a table scan (`tests/rro_disabled_state.test.mjs` checks the query plan).

**Pre-LIVE batch (P2/P3/P15, `migrations/0003_rro_rate_counters.sql`, also in the lazy schema):** `rro_rate_counters` keeps one aggregate row per (bucket, ip_hash or `global`, 10-minute window). `pack_lookup` (30 per IP), `stripe_lookup_session` (6 Stripe GETs per unpaid session, keyed by a peppered hash of the session id; P41) and `stripe_lookup` (a 1200 global ceiling for all IPs together) are exact conditional upserts that write nothing once over the limit. Over the session budget the caller gets a generic 429 `RATE_LIMITED`, and over the ceiling a 503 `UNAVAILABLE`. `public_api` (search + calculate, 120 per IP) is counted per colo for free and flushed to D1 as +10 every 10th admitted request, so a normal visitor writes nothing. "Not paid" Stripe verdicts are cached for 30 s, unless the webhook already recorded `paid`. The hourly cron deletes counter rows older than 1 h.

**P40, no pepper:** if `RRO_IP_PEPPER` is missing, search and calculate do **not** fail open. They fall back to the local limiter only (isolate memory + `caches.default`, 120 per 10 minutes), keyed by an HMAC of the /64 or IPv4 address with a random salt that each isolate makes for itself. So the fallback is per isolate, writes nothing to D1, and the zone rate-limiting rule (P42) is the cross-colo backstop. Checkout and pack lookups stay off (503) without the pepper. `deploy/build_cf_execute.mjs` refuses to upload unless the secret **name** `RRO_IP_PEPPER` is bound, and fails if the set of secret names changes during the deploy. It never reads secret values.

**P41, alert lines:** a single JSON log line `{"event":"rro_alert","alert":...}` (Workers Logs or Logpush). Nothing is sent externally, and the line has no session ids, IPs or hashes. The alerts are:
- `stripe_lookup_session_cap_hit` and `stripe_lookup_global_cap_hit`: a Stripe-lookup budget was exceeded;
- `webhook_signature_failed`, `webhook_mode_mismatch` and `webhook_record_failed`: a webhook failed. On a record failure the generic 500 makes Stripe retry;
- `webhook_paid_row_missing`: Stripe says paid but no verified webhook has recorded it yet. That means the webhook arrived late, or a delivery was missed or failed. One-offs right after a payment are a normal race; a repeat is the signal;
- `webhook_purge_failed`;
- `public_rate_limit_fallback` (pepper missing) and `public_rate_limit_d1_error`.

Alert on any `rro_alert` from a Workers Logs query or a Logpush filter, and also on Stripe's own webhook-failure emails.

**P53, daily checkout ceiling:** this is `rro_rate_counters`, bucket `checkout_daily`, key `global`, with one row per UTC day. It is counted with the same conditional upsert, after the per-IP limit, so one IP's refused attempts never use up the day.
- The row is kept 48 h, because the hourly purge skips it until then.
- `checkout_daily_volume_high` is logged once the day reaches 50% of the cap, and `checkout_daily_cap_hit` at the cap. Both are throttled as in P55.
- `checkout_daily_counter_failed` is logged on a counter error (fail closed).

**P55, throttling:** each alert type logs at most once per 60 s per isolate. The next line after a quiet window carries `suppressed: N`. Throttling is per type, so a flood of one type (for example unsigned webhooks) never hides another (for example `webhook_record_failed`). Workers Logs must be enabled on the script for these lines to be kept; at deploy 8 it was not.

**P51, paid path and D1 write failures:** once Stripe has confirmed a session as paid, the buyer always gets the pack:
- recording `paid` is best-effort, and a failure only logs the `pack_record_failed` alert. The Stripe-retried webhook records it later;
- a lazy-schema write failure (`pack_schema_write_failed`) does not block the read;
- a `pack_lookup` counter write error (`pack_counter_write_failed`) fails **open** only for sessions already recorded as paid. Unpaid sessions fail **closed** with a generic 503, so a D1 outage never opens the Stripe path.

**P54, deploy guard:** `deploy/build_cf_execute.mjs` checks names before any write: it reads settings, then creates or reads D1, then uploads.
- It refuses unless `RRO_IP_PEPPER` is bound.
- It refuses if any binding named `RRO_STRIPE_LIVE_ENABLED` exists, unless the payload was built with `--live` (`node deploy/build_cf_execute.mjs "msg" --live`). That makes changing the live flag a deliberate act.
- After the upload, a change in secret names means STOP. It rolls back automatically to the version that was serving 100% before, and the error says whether the rollback worked.
- API errors show only Cloudflare's `errors` and `messages` arrays, never a whole response.

## Idempotency and caching
- Each `/rro` view that shows the CTA sets `rro_bn`, a random 128-bit `HttpOnly; Secure; SameSite=Lax` cookie (24h), unless a valid one already exists. The Stripe `Idempotency-Key` is SHA-256 of mode, daily `ip_hash`, that nonce, the sorted cleaned inputs and a 10-minute bucket, so a retry or double submit from one browser reuses one Checkout Session, while two browsers behind one IP never share one. With no valid nonce, each request gets a fresh random key (no dedupe).
- `caches.default` keys all live under `https://parish.technoplusit.co.uk/__rro_internal_cache/v1/` (`paid/<session_id>`, `stats`, `rl/<bucket>/<ip_hash>/<window>`); no public route serves that prefix (404).
- A Stripe session with a missing, zero or invalid `created` time is treated as outside the download window (410).
- The preview-link 302 also sends `Strict-Transport-Security`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.

## Live gate checklist (not in this pass)
All must be done, plus a fresh security review, owner approval and a separate live webhook secret, before `RRO_STRIPE_LIVE_ENABLED` is set. Marked `TODO(live-gate L1–L11)` in worker.js.
- [ ] L1 Trader identity shown before purchase
- [ ] L2 Terms of sale and refund policy
- [ ] L3 Consumer Contracts Regulations reg. 37 digital-content waiver
- [ ] L4 Privacy notice
- [ ] L5 Pre-purchase "not legal advice" notice
- [ ] L6 Product rename review
- [ ] L7 Note that the underlying OGL data is free
- [ ] L8 Estimate wording review
- [x] L9 Remove the legacy £29 intent-validation offer (`/api/rro-buy-pack`, `/api/rro/buy-pack`): removed; those paths now 404
- [ ] L10 Day-7 rule counts paid orders only and has a named owner
- [x] L11 Hourly cron trigger for the 48h `ip_hash` purge is now mandatory and set by the deploy build (see T3)

## Deploy
1. `node deploy/build_cf_execute.mjs > deploy_payload.js` — produces the Cloudflare-API `execute` payload (creates/reuses D1 `parish-rro-checkout`, uploads `worker.js` plus the `src/rro_*.js` modules with the D1 binding, merges the script's existing non-secret bindings from its current settings, keeps secrets via `keep_bindings`, and throws on any Cloudflare API response without `success`).
2. Secrets are put by the key holder (`wrangler secret put STRIPE_SECRET_KEY --name parish-statutory-almanac`, same for `STRIPE_WEBHOOK_SECRET`), plus `RRO_IP_PEPPER` (required), `RRO_PREVIEW_SECRET` (required for preview) and optionally `RRO_TELEMETRY_TOKEN` via the `openssl rand -hex 32 | wrangler secret put …` pattern, or the CF dashboard. Never echo values in chat, notes, logs or commits.
3. Smoke: the build's own post-deploy check must report `crons` containing `0 * * * *` (it throws otherwise). `curl https://parish.technoplusit.co.uk/api/rro/telemetry` → `{"status":"ok",…,"mode":"test"}`. `/rro` without preview → no CTA (`X-RRO-CTA: hidden`). `/rro?rro_preview=1` → still hidden (unsigned). `/rro?rro_preview=<signed token>` → TEST MODE CTA. From that preview browser, pay with a Stripe test card (4242…), then check `paid` increments via full telemetry (bearer).

## Tests
`node --test tests/*.test.mjs` (Node ≥ 22, uses `node:sqlite` as a D1 stand-in; Stripe is mocked). `tests/rro_disabled_state.test.mjs` proves the disabled state: with no (or malformed) Stripe env, `/rro` shows "checkout coming soon", checkout and the webhook return 503, and no request to stripe.com is made.

## Public surface hardening
- `/api/rro/stats` (and `/rro/stats`, `/api/rro-stats`) needs `Authorization: Bearer <RRO_TELEMETRY_TOKEN>` (401 otherwise); the `/rro` page, sitemap and endpoint list no longer link to it.
- `POST /api/rro-audit-pdf`, `POST /api/apify-mcp-lint` and `POST /mcp` refuse bodies over 64 KB with 413 (declared `Content-Length` checked first, then a bounded streamed read).
- `/rro` and the claim-check response use plain user-facing wording (`privacy_note`, `data_source`); internal implementation terms and field names are not exposed.
- `POST /api/rro-search` and `POST /api/rro-calculate` (and their `/api/rro/search`, `/api/rro/calculate` aliases) refuse bodies over **16 KiB** with 413 `{"status":"error","error":"PAYLOAD_TOO_LARGE","max_bytes":16384}` (declared `Content-Length` first, then a bounded streamed count, so chunked or mis-declared bodies are cut off just past the cap). A full POST with every field is ~350 bytes.
- `POST /api/rro/checkout` (4 KB) and the Stripe webhook (256 KiB) use the same bounded streaming read, so a body without `Content-Length` is cut off at the cap (413). `POST /api/pdf-clause-extract` has the 64 KB cap too.
- Pack lookups are serialised per limiter key inside an isolate and the count is re-read after the cache read, so parallel requests cannot all pass on one stale count.
- A pack lookup refuses a Stripe session whose `livemode` disagrees with the key mode (502, nothing recorded), matching the webhook check.
- `/api/rro/pack`, `/rro/pack/success` and `/api/rro/telemetry` answer other methods with 405 and `Allow: GET, HEAD`.
- The sitemap constant is unchanged from main; `/rro/stats` is filtered out when the sitemap is served.
- Checkout DDL runs once per isolate (a module-level promise, retried after a failure).
- **Accepted LOW:** the public `/api/rro/telemetry` keeps `mode` (`test`/`live`/`unavailable`) and `price_gbp`. They are the documented public contract the smoke test reads, and the price is already shown on the page.

