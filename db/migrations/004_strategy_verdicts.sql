CREATE TABLE IF NOT EXISTS strategy_verdicts (
  id BIGSERIAL PRIMARY KEY,
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  flags TEXT[] NOT NULL,
  approved BOOLEAN NOT NULL,
  train_return_pct NUMERIC NOT NULL,
  validation_return_pct NUMERIC NOT NULL,
  test_return_pct NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (strategy_name, strategy_version)
);

CREATE INDEX IF NOT EXISTS idx_verdicts_approved
  ON strategy_verdicts(strategy_name, strategy_version, approved);
