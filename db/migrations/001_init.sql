CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_security_check_at TIMESTAMPTZ,
  last_security_evidence JSONB
);

CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_mint TEXT NOT NULL REFERENCES tokens(mint),
  strategy TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_request_id TEXT NOT NULL UNIQUE,
  signal_id UUID REFERENCES signals(id),
  token_mint TEXT NOT NULL REFERENCES tokens(mint),
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  amount_sol NUMERIC NOT NULL CHECK (amount_sol > 0),
  risk_decision JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXECUTED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES trade_proposals(id),
  trade_request_id TEXT NOT NULL,
  tx_signature TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('SUBMITTED','CONFIRMED','FAILED')),
  error TEXT,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portfolio_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  open_positions INT NOT NULL DEFAULT 0,
  equity_sol NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_pnl (
  date DATE PRIMARY KEY,
  realized_pnl_sol NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON trade_proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_token ON trade_proposals(token_mint);
CREATE INDEX IF NOT EXISTS idx_executions_proposal ON executions(proposal_id);
