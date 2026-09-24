import { Backtester } from '../backtest/engine';
import { PostgresBarStore, linkNextPrices } from '../state/bars';
import { MomentumStrategy, defaultMomentumConfig } from '../strategy/momentum';
import { getPool, closePool } from '../infra/db';
import { config } from '../config';
import { logger } from '../utils/logger';

interface CliArgs {
  tokenMint: string;
  fromMs: number;
  toMs: number;
  split: 'train' | 'validation' | 'test';
}

/** Parse --last 2h / 30m / 7d into milliseconds. */
function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`Invalid --last value: ${s}. Use e.g. 30m, 2h, 7d`);
  const n = Number(m[1]);
  const unit = m[2];
  switch (unit) {
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (key: string) => {
    const i = args.indexOf(`--${key}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const tokenMint = get('mint');
  if (!tokenMint) {
    throw new Error('Usage: --mint <mint> (--last 2h | --from <ISO> --to <ISO>) [--split train|validation|test]');
  }
  const split = (get('split') ?? 'train') as CliArgs['split'];
  const last = get('last');
  if (last) {
    const toMs = Date.now();
    const fromMs = toMs - parseDuration(last);
    return { tokenMint, fromMs, toMs, split };
  }
  const fromIso = get('from');
  const toIso = get('to');
  if (!fromIso || !toIso) {
    throw new Error('Provide either --last <duration> or both --from and --to');
  }
  return {
    tokenMint,
    fromMs: Date.parse(fromIso),
    toMs: Date.parse(toIso),
    split,
  };
}

async function main() {
  if (!config.DATABASE_URL) {
    logger.fatal('DATABASE_URL required for backtest CLI');
    process.exit(1);
  }
  const { tokenMint, fromMs, toMs, split } = parseArgs();
  const store = new PostgresBarStore(getPool());
  const raw = await store.get(tokenMint, fromMs, toMs);
  const bars = linkNextPrices(raw);

  logger.info(
    { tokenMint, bars: bars.length, split, fromMs, toMs },
    'Running backtest',
  );

  const bt = new Backtester(new MomentumStrategy(defaultMomentumConfig), {
    feeRate: 0.002,
    slippageRate: 0.003,
    initialEquitySol: 10,
    riskPerTradeSol: 0.1,
    maxPositionSol: 0.1,
    split,
  });
  const r = bt.run(bars);

  console.log(JSON.stringify({
    split: r.split,
    bars: r.bars,
    trades: r.trades.length,
    metrics: r.metrics,
    profitableAfterCosts: r.profitableAfterCosts,
  }, null, 2));

  await closePool();
}

main().catch((err) => {
  logger.fatal({ err }, 'backtest CLI failed');
  process.exit(1);
});
