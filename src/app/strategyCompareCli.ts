import { WalkForwardValidator, defaultWalkForwardConfig, defaultStops } from '../backtest/walkForward';
import { selectSlippageModel } from '../backtest/slippageFactory';
import { PostgresBarStore, linkNextPrices } from '../state/bars';
import { MomentumStrategy, defaultMomentumConfig } from '../strategy/momentum';
import {
  HoldNothingStrategy,
  AlwaysBuyStrategy,
  SeededRandomStrategy,
} from '../strategy/baselines';
import { Strategy } from '../strategy/types';
import { BacktestResult } from '../backtest/types';
import { getPool, closePool } from '../infra/db';
import { config } from '../config';
import { logger } from '../utils/logger';

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

interface Row {
  strategy: string;
  version: string;
  flags: string[];
  train: WindowSummary;
  validation: WindowSummary;
  test: WindowSummary;
}

interface WindowSummary {
  trades: number;
  returnPct: number;
  winRate: number;
  maxDrawdownPct: number;
  profitableAfterCosts: boolean;
}

function summarize(r: BacktestResult): WindowSummary {
  return {
    trades: r.trades.length,
    returnPct: round(r.metrics.totalReturnPct, 4),
    winRate: round(r.metrics.winRate, 4),
    maxDrawdownPct: round(r.metrics.maxDrawdownPct, 4),
    profitableAfterCosts: r.profitableAfterCosts,
  };
}

function round(n: number, d: number): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function evaluate(strategy: Strategy, bars: ReturnType<typeof linkNextPrices>): Row {
  const slippageModel = selectSlippageModel(
    process.env.SLIPPAGE_MODEL,
    defaultWalkForwardConfig.backtest.slippageRate,
  );
  const validator = new WalkForwardValidator(strategy, {
    ...defaultWalkForwardConfig,
    stops: defaultStops,
    slippageModel,
  });
  const verdict = validator.run(bars);
  return {
    strategy: strategy.name,
    version: strategy.version,
    flags: verdict.flags,
    train: summarize(verdict.train),
    validation: summarize(verdict.validation),
    test: summarize(verdict.test),
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

  const DEMO_MINT = 'DEMO_TOKEN_MINT_11111111111111111111111111111';
  // Rule 19: 0.2 * N >= MIN_WINDOW (20)  →  N >= 100.
  const MIN_REAL_BARS = 100;
  const isDemo = tokenMint === DEMO_MINT;
  if (!isDemo && bars.length < MIN_REAL_BARS) {
    logger.fatal(
      {
        event: 'INSUFFICIENT_DATA',
        tokenMint,
        bars: bars.length,
        required: MIN_REAL_BARS,
        hint: 'Run `npm run data:status` to see how long until the mint has enough bars.',
      },
      'Refusing to run strategy:compare on insufficient real data (Rule 30).',
    );
    await closePool();
    process.exit(1);
  }

  logger.info(
    { tokenMint, bars: bars.length, kind: isDemo ? 'synthetic' : 'real' },
    'Comparing strategies',
  );

  const candidates: Strategy[] = [
    new HoldNothingStrategy(),
    new AlwaysBuyStrategy(0.1),
    new SeededRandomStrategy(12345, 0.15, 0.1),
    new MomentumStrategy(defaultMomentumConfig),
  ];

  const rows: Row[] = candidates.map((s) => evaluate(s, bars));

  // Rule 18: side-by-side comparison, honest about every column.
  console.log(JSON.stringify({
    mint: tokenMint,
    bars: bars.length,
    comparison: rows,
  }, null, 2));

  await closePool();
}

main().catch((err) => {
  logger.fatal({ err }, 'strategyCompare failed');
  process.exit(1);
});
