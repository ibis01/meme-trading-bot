-- P0-4a: real position ledger (Rule 6, Rule 15, Rule 21).
-- The position row is a summary; position_fills is the immutable source of truth.

CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_mint TEXT NOT NULL UNIQUE,
  quantity NUMERIC NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  avg_cost_sol NUMERIC NOT NULL DEFAULT 0 CHECK (avg_cost_sol >= 0),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS position_fills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id UUID NOT NULL REFERENCES positions(id),
  trade_request_id TEXT NOT NULL UNIQUE,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  price_sol NUMERIC NOT NULL CHECK (price_sol > 0),
  total_sol NUMERIC NOT NULL CHECK (total_sol > 0),
  signature TEXT,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_positions_open ON positions(quantity) WHERE quantity > 0;
CREATE INDEX IF NOT EXISTS idx_fills_position ON position_fills(position_id);
