-- 008: pool event capture for signal validation.
-- Records every pump.fun creation event with cadence context.
-- Records price observations for tokens that pass the cadence filter.

CREATE TABLE IF NOT EXISTS pool_events (
  mint                 TEXT PRIMARY KEY,
  creator              TEXT NOT NULL,
  detected_at_ms       BIGINT NOT NULL,
  slot                 BIGINT,
  signature            TEXT,
  pool_address         TEXT,
  prior_launches_24h   INT NOT NULL,
  passes_signal        BOOLEAN NOT NULL DEFAULT FALSE,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pool_events_detected_idx
  ON pool_events (detected_at_ms DESC);
CREATE INDEX IF NOT EXISTS pool_events_creator_idx
  ON pool_events (creator, detected_at_ms DESC);
CREATE INDEX IF NOT EXISTS pool_events_signal_idx
  ON pool_events (mint) WHERE passes_signal = TRUE;

CREATE TABLE IF NOT EXISTS price_observations (
  id               BIGSERIAL PRIMARY KEY,
  mint             TEXT NOT NULL,
  elapsed_ms       INT NOT NULL,
  observed_at_ms   BIGINT NOT NULL,
  price_usd        DOUBLE PRECISION,
  liquidity_usd    DOUBLE PRECISION,
  volume_24h_usd   DOUBLE PRECISION,
  source           TEXT NOT NULL,
  UNIQUE (mint, observed_at_ms)
);

CREATE INDEX IF NOT EXISTS price_obs_mint_idx
  ON price_observations (mint, elapsed_ms);
