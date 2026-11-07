-- Daily counters for GET /stats (cache hits by layer, provider used, busy
-- replies, trials granted/refused, rate limits)
CREATE TABLE IF NOT EXISTS stats (
  day   TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  name  TEXT NOT NULL,              -- e.g. cache:hit:d1, ai:Groq, trial:refused:fix
  count INTEGER NOT NULL,
  PRIMARY KEY (day, name)
);
