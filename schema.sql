-- gtm-signal-pipeline D1 schema
-- The database is the source of truth. The queue is a notifier.

CREATE TABLE IF NOT EXISTS signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id     TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,          -- inbox-first dedup: same payload never ingests twice
  source       TEXT NOT NULL,                 -- e.g. 'website_visit', 'form_fill', 'webhook'
  payload      TEXT NOT NULL,                 -- raw JSON, frozen at ingest (snapshot discipline)
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','in_flight','routed','failed')),
  fit_score    INTEGER,                       -- 0-100, org-structure-to-buy
  intent_score INTEGER,                       -- 0-100, behavior-says-they-will
  reasoning    TEXT,                          -- the why-now payload, frozen at scoring time
  scored_by    TEXT,                          -- 'deterministic' | 'ai:<model>' | 'deterministic-fallback'
  claimed_at   TEXT,                          -- set by atomic claim; reaper compares against TTL
  routed_at    TEXT,
  reap_count   INTEGER NOT NULL DEFAULT 0,    -- times the reaper rescued this row
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_trace ON signals(trace_id);

CREATE TABLE IF NOT EXISTS routed_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id  INTEGER NOT NULL REFERENCES signals(id),
  trace_id   TEXT NOT NULL,
  tier       TEXT NOT NULL CHECK (tier IN ('hot','warm','archive')),
  action     TEXT NOT NULL,                   -- what a production system would do: 'alert_rep', 'nurture', 'archive'
  reason     TEXT NOT NULL,                   -- never route without saying why
  dry_run    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_actions_signal ON routed_actions(signal_id);
