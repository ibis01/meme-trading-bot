-- Security remediation (audit 2026-11-08, finding #5): claim-based debate
-- idempotency. The UNIQUE (signal_id, mode) constraint on debate_verdicts
-- deduplicates ROWS but not WORK: two concurrent advise() calls for the same
-- signal both miss the cache read and both run the 3-call LLM protocol —
-- paying twice. debate_claims is an exclusive lease: the first worker to
-- INSERT wins; everyone else skips (fail-open, zero spend). A worker that
-- dies mid-debate leaves a lease that expires (lease_expires_at), after
-- which the next caller atomically steals it (UPDATE ... WHERE lease
-- expired). Verdict rows remain the durable record in debate_verdicts.
CREATE TABLE IF NOT EXISTS debate_claims (
  signal_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shadow','advise')),
  owner_id UUID NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (signal_id, mode)
);
CREATE INDEX IF NOT EXISTS idx_debate_claims_lease ON debate_claims(lease_expires_at);
