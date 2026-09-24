import { WalkForwardValidator, defaultWalkForwardConfig, defaultStops } from '../backtest/walkForward';
import { PostgresBarStore, linkNextPrices } from '../state/bars';
import { MomentumStrategy, defaultMomentumConfig } from '../strategy/momentum';
import { getPool, closePool } from '../infra/db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { BacktestResult } from '../backtest/types';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (key: string) => {
    const i = args.indexOf(`--${key}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const tokenMint = get('mint');
  const last = get('last') ?? '7d';
  if (!tokenMint) throw new Error('Usage: --mint <mint> [--last 7d]');
  const m = /^(\d+)([smhd])$/.exec(last);
  if (!m) throw new Error(`Invalid --last: ${last}`);
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return { tokenMint, fromMs: Date.now() - n * mult, toMs: Date.now() };
}

function summarizeWindow(r: BacktestResult) {
  return {
    bars: r.bars,
    trades: r.trades.length,
    returnPct: r.metrics.totalReturnPct,
    winRate: r.metrics.winRate,
    profitFactor: r.metrics.profitFactor,
    expectancyPct: r.metrics.expectancyPct,
    maxDrawdownPct: r.metrics.maxDrawdownPct,
    consecutiveLosses: r.metrics.consecutiveLosses,
    feesPaidSol: r.metrics.feesPaidSol,
    slippagePaidSol: r.metrics.slippagePaidSol,
    profitableAfterCosts: r.profitableAfterCosts,
  };
}

async function main() {
  if (!config.DATABASE_URL) {
    logger.fatal('DATABASE_URL required');
    process.exit(1);
  }
  const { tokenMint, fromMs, toMs } = parseArgs();
  const store = new PostgresBarStore(getPool());
  const raw = await store.get(tokenMint, fromMs, toMs);
  const bars = linkNextPrices(raw);

  logger.info({ tokenMint, bars: bars.length }, 'Running walk-forward with stops');

  const validator = new WalkForwardValidator(
    new MomentumStrategy(defaultMomentumConfig),
    { ...defaultWalkForwardConfig, stops: defaultStops },
  );
  const verdict = validator.run(bars);

  console.log(JSON.stringify({
    flags: verdict.flags,
    summary: verdict.summary,
    windows: {
      train: summarizeWindow(verdict.train),
      validation: summarizeWindow(verdict.validation),
      test: summarizeWindow(verdict.test),
    },
  }, null, 2));

  await closePool();
}

main().catch((err) => {
  logger.fatal({ err }, 'walk-forward CLI failed');
  process.exit(1);
});
