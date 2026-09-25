import { getPool, closePool } from '../infra/db';
import { config } from '../config';
import { logger } from '../utils/logger';

const DEMO_MINT = 'DEMO_TOKEN_MINT_11111111111111111111111111111';
// Walk-forward needs 60 bars to even run.
// For a gate-meaningful sample (≥ 15 trades per window at 30-min holds
// on 30s bars = 60 bars per trade): ~900 bars per window → ~4500 total.
// Rule 19: walk-forward needs MIN_WINDOW bars per window (20 in walkForward.ts).
// With 60/20/20 split, the binding constraint is: 0.2 * N >= 20  →  N >= 100.
const MIN_TO_RUN = 100;
const TARGET_FOR_MEANINGFUL = 4500;
const SECONDS_PER_BAR = 30;

interface Row {
  token_mint: string;
  count: string;
}

async function main() {
  if (!config.DATABASE_URL) {
    logger.fatal('DATABASE_URL required');
    process.exit(1);
  }
  const pool = getPool();
  const res = await pool.query<Row>(
    `SELECT token_mint, COUNT(*)::text AS count
       FROM price_bars
      GROUP BY token_mint
      ORDER BY COUNT(*) DESC`,
  );

  const report = res.rows.map((r) => {
    const count = Number(r.count);
    const isDemo = r.token_mint === DEMO_MINT;
    const secondsToRun = Math.max(0, MIN_TO_RUN - count) * SECONDS_PER_BAR;
    const secondsToMeaningful = Math.max(0, TARGET_FOR_MEANINGFUL - count) * SECONDS_PER_BAR;
    return {
      mint: r.token_mint,
      bars: count,
      kind: isDemo ? 'synthetic' : 'real',
      canRunWalkForward: isDemo || count >= MIN_TO_RUN,
      meaningfulSample: isDemo || count >= TARGET_FOR_MEANINGFUL,
      etaRun: isDemo ? 'ready' : fmtEta(secondsToRun),
      etaMeaningful: isDemo ? 'ready' : fmtEta(secondsToMeaningful),
    };
  });

  console.log(JSON.stringify({
    thresholds: { MIN_TO_RUN, TARGET_FOR_MEANINGFUL, SECONDS_PER_BAR },
    mints: report,
  }, null, 2));

  await closePool();
}

function fmtEta(seconds: number): string {
  if (seconds === 0) return 'ready';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `~${h}h ${m}m`;
  return `~${m}m`;
}

main().catch((err) => {
  logger.fatal({ err }, 'data:status failed');
  process.exit(1);
});
