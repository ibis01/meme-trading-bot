CREATE TABLE IF NOT EXISTS proposal_rejections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_request_id VARCHAR(255) UNIQUE NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  strategy VARCHAR(50) NOT NULL,
  strategy_version VARCHAR(20) NOT NULL,
  reason_code VARCHAR(100) NOT NULL,
  evidence JSONB NOT NULL,
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rejections_token ON proposal_rejections(token_mint);
CREATE INDEX IF NOT EXISTS idx_rejections_reason ON proposal_rejections(reason_code);
