-- LeetHint D1 schema. Apply with:
--   npx wrangler d1 migrations apply leethint --remote
-- (and without --remote for the local `wrangler dev` database)

-- Shared reply cache (replaces the HINTS_CACHE KV namespace).
-- key = "<promptVersion>:<action>[-<lang>]:<slug>:<sha256(prompt)>"
CREATE TABLE IF NOT EXISTS cache (
  key     TEXT PRIMARY KEY,
  kind    TEXT NOT NULL,          -- stream format: openai | workersai | gemini
  body    TEXT NOT NULL,          -- the raw SSE reply
  created INTEGER NOT NULL        -- unix ms
);

-- "Report wrong hint" — one per install, problem and UTC day
CREATE TABLE IF NOT EXISTS reports (
  install_id     TEXT NOT NULL,
  slug           TEXT NOT NULL,
  day            TEXT NOT NULL,   -- YYYY-MM-DD (UTC)
  prompt_version TEXT NOT NULL,
  reason         TEXT NOT NULL,   -- wrong_solution | wrong_hint | other
  note           TEXT NOT NULL DEFAULT '',
  created        INTEGER NOT NULL,
  PRIMARY KEY (install_id, slug, day)
);
CREATE INDEX IF NOT EXISTS reports_by_slug ON reports (slug, created);

-- Free-trial counters: period = YYYY-MM-DD (fix) or YYYY-Www (interview)
CREATE TABLE IF NOT EXISTS usage (
  install_id TEXT NOT NULL,
  period     TEXT NOT NULL,
  action     TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (install_id, period, action)
);

-- Interviews already admitted as a trial, so each interviewId counts once
CREATE TABLE IF NOT EXISTS trial_interviews (
  interview_id TEXT PRIMARY KEY,
  install_id   TEXT NOT NULL,
  created      INTEGER NOT NULL
);

-- Abusive installs → 403 { "error": "blocked" }
CREATE TABLE IF NOT EXISTS blocked (
  install_id TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT '',
  created    INTEGER NOT NULL DEFAULT 0
);
