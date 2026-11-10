-- P2/P3/P15 (pre-LIVE batch): aggregate fixed-window rate-limit counters (D1 binding RRO_CHECKOUT_DB).
-- One row per (bucket, key_hash, window) instead of one row per hit:
--   bucket 'public_api'    per-IP search + calculate limit (P15); +10 per flush, so <= 12 upserts per IP per colo per 10 min
--   bucket 'pack_lookup'   per-IP /api/rro/pack + /rro/pack/success limit, global across colos (P3)
--   bucket 'stripe_lookup' key_hash 'global': cap on Stripe session GETs across all IPs (P2)
-- key_hash is the peppered daily HMAC ip_hash (32 hex) or the literal 'global'; raw IPs are never stored.
-- The hourly cron (scheduled) deletes rows whose window started more than 1 h ago.
-- Additive only: creates one new table and one index; no existing table, row or index is changed.
-- The Worker also creates these lazily (IF NOT EXISTS, in RRO_CHECKOUT_SCHEMA); this file is the reviewable source of truth.
CREATE TABLE IF NOT EXISTS rro_rate_counters (
  bucket TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  window_start_utc TEXT NOT NULL,   -- ISO-8601 UTC start of the fixed window
  n INTEGER NOT NULL,
  PRIMARY KEY (bucket, key_hash, window_start_utc)
);
CREATE INDEX IF NOT EXISTS ix_rro_rate_counters_window ON rro_rate_counters(window_start_utc);
