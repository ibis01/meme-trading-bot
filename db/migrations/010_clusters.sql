CREATE TABLE IF NOT EXISTS cluster_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_mint VARCHAR(44) NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  wallet_count INTEGER NOT NULL,
  unique_funders_count INTEGER NOT NULL,
  total_buy_sol NUMERIC NOT NULL,
  time_window_ms INTEGER NOT NULL,
  liquidity_usd NUMERIC,
  momentum_score NUMERIC,
  narrative_score NUMERIC,
  is_actionable BOOLEAN DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_cluster_signals_token ON cluster_signals(token_mint);
CREATE INDEX IF NOT EXISTS idx_cluster_signals_detected ON cluster_signals(detected_at);

CREATE TABLE IF NOT EXISTS shadow_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id UUID REFERENCES cluster_signals(id),
  token_mint VARCHAR(44) NOT NULL,
  entry_price NUMERIC NOT NULL,
  exit_price NUMERIC,
  pnl_sol NUMERIC,
  status VARCHAR(20) DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_status ON shadow_trades(status);
