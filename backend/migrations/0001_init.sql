-- LeetHint D1 schema (apply with: npx wrangler d1 migrations apply leethint --remote)

-- Shared AI replies (hints, solutions, translations, signature fixes).
-- key = <promptVersion>:<action>[-<language>]:<slug>:<sha256 of the prompt>
CREATE TABLE IF NOT EXISTS cache (
  key     TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,            -- stream format: openai | workersai | gemini
  body    TEXT NOT NULL,            -- the raw SSE reply, served back as-is
  created INTEGER NOT NULL          -- unix seconds
);

-- "This hint/solution is wrong" reports — one per problem, reporter and day
CREATE TABLE IF NOT EXISTS reports (
  slug           TEXT NOT NULL,
  day            TEXT NOT NULL,     -- YYYY-MM-DD (UTC)
  reporter       TEXT NOT NULL,     -- install ID, or a hash of the IP
  prompt_version TEXT,
  reason         TEXT NOT NULL,
  note           TEXT,
  created        INTEGER NOT NULL,
  PRIMARY KEY (slug, day, reporter)
);

-- Free-trial use per install: action 'fix' per day, 'interview' per ISO week
CREATE TABLE IF NOT EXISTS usage (
  install_id TEXT NOT NULL,
  period     TEXT NOT NULL,         -- 2026-11-07 or 2026-W45
  action     TEXT NOT NULL,
  count      INTEGER NOT NULL,
  PRIMARY KEY (install_id, period, action)
);

-- Interviews already admitted, so later turns of the same one don't count again
CREATE TABLE IF NOT EXISTS interviews (
  interview_id TEXT PRIMARY KEY,
  install_id   TEXT NOT NULL,
  created      INTEGER NOT NULL
);

-- Install IDs refused outright (abuse)
CREATE TABLE IF NOT EXISTS blocked (
  install_id TEXT PRIMARY KEY,
  reason     TEXT,
  created    INTEGER NOT NULL
);
