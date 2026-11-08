-- Phase 2: multi-agent LLM debate verdicts (advisory layer).
-- See docs/PHASE2_DESIGN.md §6. Rule 28: advisory only — the debate layer can
-- only reduce entries (veto), never approve or enlarge. The risk engine
-- remains final; nothing in the executor reads this table.
CREATE TABLE IF NOT EXISTS debate_verdicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id TEXT NOT NULL,
  trade_request_id TEXT NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shadow','advise')),
  outcome TEXT NOT NULL CHECK (outcome IN ('COMPLETED','UNAVAILABLE','INVALID')),
  stance TEXT CHECK (stance IN ('SUPPORT','OPPOSE','ABSTAIN')),
  confidence NUMERIC,
  veto_recommended BOOLEAN,
  verdict JSONB,                    -- validated judge output (NULL unless COMPLETED)
  transcript JSONB NOT NULL,        -- all role messages, usage, latencies
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  cost_usd_est NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (signal_id, mode)
);
CREATE INDEX IF NOT EXISTS idx_debate_stance ON debate_verdicts(outcome, stance, veto_recommended);
CREATE INDEX IF NOT EXISTS idx_debate_token ON debate_verdicts(token_mint);
CREATE INDEX IF NOT EXISTS idx_debate_created ON debate_verdicts(created_at);
