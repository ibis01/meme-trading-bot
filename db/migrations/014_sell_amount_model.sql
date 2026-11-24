-- Audit C4 (2026-11-24): SELL proposals never carry an SOL amount — their
-- size is expressed by sell_percent_bps (fraction of the held position).
-- The old schema forced amount_sol > 0, which every SELL path violated
-- (they all carried 0): any SELL proposal would crash the Postgres insert.
--
-- BUY  → amount_sol must be present and positive (the SOL being spent).
-- SELL → amount_sol is NULL; sell_percent_bps ∈ [1, 10000] is the sizing
--        evidence (Rule 20/21: the trade must stay explainable).

ALTER TABLE trade_proposals ALTER COLUMN amount_sol DROP NOT NULL;

ALTER TABLE trade_proposals
  DROP CONSTRAINT IF EXISTS trade_proposals_amount_sol_check;

ALTER TABLE trade_proposals
  ADD CONSTRAINT trade_proposals_amount_sol_check
  CHECK (amount_sol IS NULL OR amount_sol > 0);

ALTER TABLE trade_proposals
  ADD COLUMN IF NOT EXISTS sell_percent_bps INT;

-- Historical SELL rows written before this fix carry amount_sol = 0 and no
-- bps evidence. Full-close (10_000) is the only recoverable default. This
-- amendment MUST run before the constraint below is validated, otherwise
-- any pre-existing SELL row fails the migration.
UPDATE trade_proposals
  SET sell_percent_bps = 10_000
  WHERE side = 'SELL' AND sell_percent_bps IS NULL;

-- Stricter than the reviewed sketch: a SELL row must actually carry its
-- sizing evidence (a bare NULL bps would silently pass the BETWEEN arm).
ALTER TABLE trade_proposals
  DROP CONSTRAINT IF EXISTS trade_proposals_side_amount_check;

ALTER TABLE trade_proposals
  ADD CONSTRAINT trade_proposals_side_amount_check
  CHECK (
    (side = 'BUY' AND amount_sol IS NOT NULL AND amount_sol > 0)
    OR
    (side = 'SELL' AND sell_percent_bps IS NOT NULL
      AND sell_percent_bps BETWEEN 1 AND 10000)
  );
