-- Gate 1 (audit 2026-11-09): durable reconciliation repair queue + fill
-- signature uniqueness.
--
-- Defect 1: delayed reconciliation could mark an execution CONFIRMED without
-- updating positions/PnL, and nothing durable recorded the gap. Once an
-- execution is CONFIRMED it leaves the unresolved scan, so the unbooked fill
-- was invisible forever. Fix: reconciliation_repairs — a persistent queue of
-- fills that landed on-chain but could not be booked. While any repair is
-- OPEN the risk engine blocks new BUYs (exits stay available) — portfolio
-- state is never allowed to drift silently.
--
-- Defect 2: position_fills.signature had no uniqueness constraint, so the
-- same on-chain transaction could be booked twice (double position/PnL) via
-- concurrent reconciliation + execution paths.

CREATE TABLE IF NOT EXISTS reconciliation_repairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id UUID,
  trade_request_id TEXT NOT NULL,
  token_mint TEXT,
  side TEXT CHECK (side IS NULL OR side IN ('BUY','SELL')),
  tx_signature TEXT,
  reason TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT
);

-- At most one OPEN repair per trade request: re-adding an existing open
-- repair is an idempotent no-op instead of a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_repairs_open_request
  ON reconciliation_repairs(trade_request_id) WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS idx_repairs_status
  ON reconciliation_repairs(status, created_at);

-- Gate 2: one ledger fill per on-chain transaction signature. NULL/empty
-- signatures (paper fills use synthetic paper_* signatures, pre-submit
-- failures have none) are exempt via the partial index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_position_fills_signature
  ON position_fills(signature)
  WHERE signature IS NOT NULL AND signature <> '';
