-- TC2: the retention purge (DELETE FROM rro_rate_hits WHERE created_at_utc < ?) filters on
-- created_at_utc alone; this index stops it scanning the whole table. Also created lazily by the Worker.
CREATE INDEX IF NOT EXISTS ix_rro_rate_hits_created_at ON rro_rate_hits(created_at_utc);
