-- Gate 1 (audit 2026-11-09): SELL proposals carry a fraction of the position
-- (sell_percent_bps), never a fabricated SOL notional.
--
-- Defect: 001_init.sql declared `amount_sol NUMERIC NOT NULL CHECK (amount_sol > 0)`.
-- A SELL proposal has no meaningful SOL amount (the closed quantity is token
-- units, resolved from the position ledger at execution time), so every SELL
-- insert violated the CHECK or was forced to carry a fake positive amount.
-- The actual exit fraction (sellPercentBps) lived only inside the
-- risk_decision JSON blob — invisible to SQL constraints and queries.
--
-- This migration makes the data model match reality:
--   BUY  → amount_sol NOT NULL AND > 0, sell_percent_bps NULL.
--   SELL → amount_sol NULL, sell_percent_bps BETWEEN 1 AND 10000.

ALTER TABLE trade_proposals ADD COLUMN IF NOT EXISTS sell_percent_bps INTEGER;

-- Backfill from the risk_decision JSON blob (the only place it existed).
UPDATE trade_proposals
  SET sell_percent_bps = (risk_decision->'proposal'->>'sellPercentBps')::int
  WHERE side = 'SELL' AND sell_percent_bps IS NULL;

-- SELL rows must not carry a fake SOL notional (informational only before;
-- NULL is now the honest value).
UPDATE trade_proposals SET amount_sol = NULL WHERE side = 'SELL';

ALTER TABLE trade_proposals ALTER COLUMN amount_sol DROP NOT NULL;

-- 001_init.sql created the inline `CHECK (amount_sol > 0)` constraint; Postgres
-- auto-named it trade_proposals_amount_sol_check. Drop it before adding the
-- composite side-aware gate (idempotent for fresh databases where the inline
-- check was already replaced).
ALTER TABLE trade_proposals DROP CONSTRAINT IF EXISTS trade_proposals_amount_sol_check;

ALTER TABLE trade_proposals DROP CONSTRAINT IF EXISTS side_amount_check;
ALTER TABLE trade_proposals ADD CONSTRAINT side_amount_check CHECK (
  (side = 'BUY' AND amount_sol IS NOT NULL AND amount_sol > 0)
  OR
  -- Strict form: a SELL row without a persisted fraction is a data-model
  -- defect and must fail the insert (the directive's BETWEEN clause alone
  -- would silently pass NULL).
  (side = 'SELL' AND sell_percent_bps IS NOT NULL
     AND sell_percent_bps BETWEEN 1 AND 10000)
);
