-- DexScreener does not expose holder data. Rule 30: store unknown as NULL,
-- never fabricate 0. Idempotent (migrate.ts re-applies every file).
ALTER TABLE price_bars
  ALTER COLUMN holder_count DROP NOT NULL,
  ALTER COLUMN top10_holder_percent DROP NOT NULL;
