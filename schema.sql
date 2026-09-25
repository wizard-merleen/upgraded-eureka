-- Electro Clinic: schema for shared Postgres storage (replaces data.json)
-- Runs automatically on server startup (see server.js), but safe to run by hand too.

CREATE TABLE IF NOT EXISTS tickets (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'Received',
  answer    TEXT DEFAULT '',
  email     TEXT DEFAULT '',
  name      TEXT,
  phone     TEXT,
  service   TEXT,
  date      TEXT,
  time      TEXT,
  details   TEXT,
  urgent    BOOLEAN DEFAULT false,
  refby     TEXT DEFAULT '',
  refpaid   BOOLEAN DEFAULT false,
  created   BIGINT NOT NULL,
  reminded  BOOLEAN DEFAULT false,
  stars     INT,
  review    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_email ON tickets(email);
CREATE INDEX IF NOT EXISTS idx_tickets_date ON tickets(type, date, status);

CREATE TABLE IF NOT EXISTS subs (
  endpoint  TEXT PRIMARY KEY,
  sub       JSONB NOT NULL,
  ids       TEXT[] DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS config (
  id        INT PRIMARY KEY DEFAULT 1,
  hours     TEXT DEFAULT '',
  areas     TEXT[] DEFAULT '{}',
  fee       TEXT DEFAULT '',
  notice    TEXT DEFAULT '',
  reward    TEXT DEFAULT ''
);
INSERT INTO config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  email     TEXT PRIMARY KEY,
  ref       TEXT NOT NULL,
  credits   INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token     TEXT PRIMARY KEY,
  email     TEXT NOT NULL,
  exp       BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS codes (
  email     TEXT PRIMARY KEY,
  hash      TEXT NOT NULL,
  exp       BIGINT NOT NULL,
  tries     INT NOT NULL DEFAULT 0
);

-- small key/value table for cross-machine flags (e.g. "did we already send today's summary email")
CREATE TABLE IF NOT EXISTS state (
  key       TEXT PRIMARY KEY,
  value     TEXT
);
