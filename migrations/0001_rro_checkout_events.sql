-- IDEA-03 SHAPE-O1: £24 Export Formal Tribunal Appeal Pack telemetry (D1 binding RRO_CHECKOUT_DB).
-- The Worker also creates these lazily (IF NOT EXISTS); this file is the reviewable source of truth.
CREATE TABLE IF NOT EXISTS rro_checkout_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('checkout_start','paid')),
  stripe_mode TEXT NOT NULL CHECK (stripe_mode IN ('test','live')),
  session_id TEXT,
  ip_hash TEXT,            -- sha256(day-salt + CF-Connecting-IP), truncated; raw IPs are never stored
  amount_total INTEGER,
  currency TEXT,
  created_at_utc TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rro_checkout_kind_session ON rro_checkout_events(kind, session_id);
CREATE INDEX IF NOT EXISTS ix_rro_checkout_kind_mode_time ON rro_checkout_events(kind, stripe_mode, created_at_utc);
CREATE INDEX IF NOT EXISTS ix_rro_checkout_ip_time ON rro_checkout_events(ip_hash, created_at_utc);
