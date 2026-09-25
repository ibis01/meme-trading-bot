-- P1-6: extend proposal and execution status enums for the new state machine.
-- SUBMITTED is transient (submitted but not yet confirmed).
-- UNKNOWN is ambiguous (submission attempted, outcome unclear).
-- Both keep the idempotency lock. Neither auto-retries.

ALTER TABLE trade_proposals
  DROP CONSTRAINT IF EXISTS trade_proposals_status_check;

ALTER TABLE trade_proposals
  ADD CONSTRAINT trade_proposals_status_check
  CHECK (status IN ('PENDING','APPROVED','REJECTED','SUBMITTED','EXECUTED','UNKNOWN','FAILED'));

ALTER TABLE executions
  DROP CONSTRAINT IF EXISTS executions_status_check;

ALTER TABLE executions
  ADD CONSTRAINT executions_status_check
  CHECK (status IN ('SUBMITTED','UNKNOWN','CONFIRMED','FAILED'));
