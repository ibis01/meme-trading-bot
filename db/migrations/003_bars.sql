CREATE TABLE IF NOT EXISTS price_bars (
  id BIGSERIAL PRIMARY KEY,
  token_mint TEXT NOT NULL,
  bucket_ms BIGINT NOT NULL,
  price_usd NUMERIC NOT NULL CHECK (price_usd > 0),
  liquidity_usd NUMERIC NOT NULL,
  volume_24h_usd NUMERIC NOT NULL,
  holder_count INT NOT NULL,
  top10_holder_percent NUMERIC NOT NULL,
  smart_wallet_net_flow_usd NUMERIC NOT NULL,
  price_change_5m_percent NUMERIC NOT NULL,
  price_change_1h_percent NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token_mint, bucket_ms)
);
CREATE INDEX IF NOT EXISTS idx_bars_mint_bucket ON price_bars(token_mint, bucket_ms);
