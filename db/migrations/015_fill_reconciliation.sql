-- Audit C1/C2/C3 (2026-11-24): canonical fill booking (Gate 1a).
--
-- The canonical FillBookkeeper records booking state ON the execution row:
--   booked_at IS NULL on a CONFIRMED execution = the fill never reached the
--   ledger (crash window between save and booking, or a booking failure).
-- Those rows ARE the persistent repair queue:
--   - PostgresExecutionStore.listPendingBookings() surfaces them.
--   - The reconciliation runner's repair sweep re-books them.
--   - While the queue is non-empty, new BUYs are blocked (fail-closed):
--     portfolio state cannot be trusted to size new risk.
--
-- Fill evidence is stored alongside the status update, in the SAME
-- transaction as the position/PnL writes (single derivation of truth):
--   filled_amount_sol       — SOL spent (BUY) / received (SELL), exact text.
--   filled_token_amount     — human token units (float interfaces).
--   filled_token_amount_raw — EXACT raw base units (bigint string, Gate 2).
--   fill_side               — booking side; must match the proposal's.

ALTER TABLE executions
  ADD COLUMN IF NOT EXISTS booked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS filled_amount_sol NUMERIC,
  ADD COLUMN IF NOT EXISTS filled_token_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS filled_token_amount_raw TEXT,
  ADD COLUMN IF NOT EXISTS fill_side TEXT CHECK (fill_side IN ('BUY','SELL'));

-- Repair-queue scan index: the runner sweeps this every cycle.
CREATE INDEX IF NOT EXISTS idx_executions_repair_queue
  ON executions (executed_at)
  WHERE status = 'CONFIRMED' AND booked_at IS NULL;

-- Audit C3: a transaction signature may book AT MOST ONE position fill.
-- The old schema allowed the same signature on many fills (no uniqueness),
-- so a re-run reconciliation could double-count positions and PnL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_position_fills_signature
  ON position_fills (signature)
  WHERE signature IS NOT NULL AND signature <> '';
