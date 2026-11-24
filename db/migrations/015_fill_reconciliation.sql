-- Audit C1/C2/C3 (2026-11-24): canonical fill booking.
--
-- 1. A transaction signature may book AT MOST ONE position fill. The old
--    schema allowed the same signature on many fills (no uniqueness), so a
--    re-run reconciliation could double-count positions and PnL.
--
-- 2. ledger_reconciliation_status is the durable bridge between an execution
--    that is CONFIRMED on-chain and the portfolio state derived from it.
--    Every fill booking attempt creates exactly one row:
--      PENDING       — attempt started, not yet committed (repair queue).
--      BOOKED        — position/fill/PnL committed atomically.
--      FAILED        — transient booking failure (DB hiccup); retried.
--      UNRECONCILABLE— invariant violation (e.g. SELL exceeds recorded
--                      holdings); requires operator/repair action.
--    Any row not BOOKED, plus any CONFIRMED execution without a row at all
--    (crash between execution-save and booking), sits in the repair queue.
--    While the queue is non-empty, new BUYs are blocked (fail-closed):
--    the portfolio state cannot be trusted to size new risk.

CREATE UNIQUE INDEX IF NOT EXISTS idx_position_fills_signature
  ON position_fills (signature)
  WHERE signature IS NOT NULL AND signature <> '';

CREATE TABLE IF NOT EXISTS ledger_reconciliation_status (
  execution_id  UUID PRIMARY KEY REFERENCES executions(id),
  tx_signature  TEXT,
  booking_status TEXT NOT NULL
    CHECK (booking_status IN ('PENDING','BOOKED','FAILED','UNRECONCILABLE')),
  source        TEXT NOT NULL CHECK (source IN ('IMMEDIATE','RECONCILED')),
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  fill_id       UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recon_status_unresolved
  ON ledger_reconciliation_status (updated_at)
  WHERE booking_status <> 'BOOKED';
