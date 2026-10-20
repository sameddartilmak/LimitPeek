-- LimitPeek waitlist (Cloudflare D1, which is SQLite).
-- Apply once:  npx wrangler d1 execute limitpeek-waitlist --remote --file=schema.sql
-- Safe to run again: every statement is IF NOT EXISTS.

-- One row per address. Nothing else about the visitor is kept.
CREATE TABLE IF NOT EXISTS subscribers (
  email      TEXT PRIMARY KEY CHECK (length(email) BETWEEN 3 AND 254), -- lower-cased
  tools      TEXT CHECK (tools IS NULL OR length(tools) <= 120),       -- e.g. 'claude-code,codex'; NULL = not answered
  price      TEXT CHECK (price IS NULL OR price IN ('none', 'upto3', '3to5', '5to10', 'more')),
  feature    TEXT CHECK (feature IS NULL OR length(feature) <= 200),   -- the one free-text answer
  locale     TEXT NOT NULL DEFAULT 'tr' CHECK (locale IN ('tr', 'en')), -- the page language, for the mail's language
  token      TEXT NOT NULL UNIQUE CHECK (length(token) = 64),           -- random; the unsubscribe link
  created_at TEXT NOT NULL,                                             -- ISO 8601, UTC
  updated_at TEXT NOT NULL
);

-- Rate limit: sign-ups per hour from one place. `key` is SHA-256 of a secret
-- salt, the UTC day and the IP, never the IP itself. Rows older than a day
-- are deleted on every sign-up and by the hourly cron.
CREATE TABLE IF NOT EXISTS rate_limits (
  key    TEXT NOT NULL,
  bucket INTEGER NOT NULL, -- hours since 1970-01-01 UTC
  hits   INTEGER NOT NULL,
  PRIMARY KEY (key, bucket)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS rate_limits_bucket ON rate_limits (bucket);
