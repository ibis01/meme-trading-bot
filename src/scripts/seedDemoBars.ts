import { getPool, closePool } from '../infra/db';
import { PostgresBarStore } from '../state/bars';
import { logger } from '../utils/logger';

const DEMO_MINT = 'DEMO_TOKEN_MINT_11111111111111111111111111111';

/**
 * Fat-tailed synthetic price path with REAL indicators.
 *  - Momentum signals are computed from the price path (not constants).
 *  - 2000 bars → meaningful sample sizes for each walk-forward window.
 *  - Fat-tail shocks (5% chance) create real edge opportunities.
 *
 * Development tool. Real runs use the recorder.
 */
export function generatePath(count: number, seed = 42): number[] {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const prices: number[] = [0.001];
  for (let i = 1; i < count; i++) {
    const base = normal() * 0.008;
    const fatTail = rand() < 0.05 ? normal() * 0.06 : 0;
    const momentum = rand() < 0.15 ? 0.003 : 0; // occasional momentum burst
    const ret = 0.0002 + base + fatTail + momentum;
    prices.push(prices[i - 1] * Math.max(0.2, 1 + ret));
  }
  return prices;
}

/** Percent change over the last N bars (as a percentage number, e.g. 3.5 means +3.5%). */
function pctChange(prices: number[], i: number, lookback: number): number {
  const from = Math.max(0, i - lookback);
  if (i === from) return 0;
  return ((prices[i] - prices[from]) / prices[from]) * 100;
}

async function main() {
  const pool = getPool();
  const store = new PostgresBarStore(pool);

  await pool.query('DELETE FROM price_bars WHERE token_mint = $1', [DEMO_MINT]);

  const count = 5000;
  const prices = generatePath(count);
  const now = Date.now();

  const bars = prices.map((price, i) => ({
    tokenMint: DEMO_MINT,
    fetchedAt: now - (count - i) * 60_000,
    priceUsd: price,
    nextPriceUsd: 0,
    liquidityUsd: 200_000 + i * 50,
    volume24hUsd: 1_000_000,
    holderCount: 3_000,
    top10HolderPercent: 22,
    smartWalletNetFlowUsd: 5_000,
    // Rule 30: these are computed, not hardcoded.
    priceChange5mPercent: pctChange(prices, i, 5),
    priceChange1hPercent: pctChange(prices, i, 60),
  }));

  await store.saveMany(bars);
  logger.info(
    {
      mint: DEMO_MINT,
      bars: bars.length,
      min: round4(Math.min(...prices)),
      max: round4(Math.max(...prices)),
      priceChange5mRange: [round4(Math.min(...bars.map((b) => b.priceChange5mPercent))), round4(Math.max(...bars.map((b) => b.priceChange5mPercent)))],
    },
    'Demo bars seeded (fat-tailed + real indicators)',
  );

  await closePool();
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'seedDemoBars failed');
    process.exit(1);
  });
}
