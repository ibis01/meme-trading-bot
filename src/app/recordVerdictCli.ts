import { WalkForwardValidator, defaultWalkForwardConfig } from '../backtest/walkForward';
import { PostgresBarStore, linkNextPrices } from '../state/bars';
import { MomentumStrategy, defaultMomentumConfig } from '../strategy/momentum';
import { PostgresStrategyVerdictStore } from '../state/strategyVerdicts';
import { getPool, closePool } from '../infra/db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Strategy } from '../strategy/types';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (key: string) => {
    const i = args.indexOf(`--${key}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const tokenMint = get('mint');
  const last = get('last') ?? '7d';
  const strategy = get('strategy') ?? 'MEME_MOMENTUM_V1';
  if (!tokenMint) throw new Error('Usage: --mint <mint> --last <dur> [--strategy NAME]');
  const m = /^(\d+)([smhd])$/.exec(last);
  if (!m) throw new Error(`Invalid --last: ${last}`);
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return { tokenMint, fromMs: Date.now() - n * mult, toMs: Date.now(), strategy };
}

function selectStrategy(name: string): Strategy {
  // Only one strategy implemented; add more as they land.
  if (name === 'MEME_MOMENTUM_V1') return new MomentumStrategy(defaultMomentumConfig);
  throw new Error(`Unknown strategy: ${name}`);
}

async function main() {
  if (!config.DATABASE_URL) {
    logger.fatal('DATABASE_URL required');
    process.exit(1);
  }
  const { tokenMint, fromMs, toMs, strategy } = parseArgs();
  const store = new PostgresBarStore(getPool());
  const raw = await store.get(tokenMint, fromMs, toMs);
  const bars = linkNextPrices(raw);

  const strat = selectStrategy(strategy);
  const validator = new WalkForwardValidator(strat, defaultWalkForwardConfig);
  const verdict = validator.run(bars);

  const approved = verdict.flags.includes('EDGE_CONFIRMED');

  await new PostgresStrategyVerdictStore(getPool()).upsert({
    strategyName: strat.name,
    strategyVersion: strat.version,
    flags: verdict.flags,
    approved,
    trainReturnPct: verdict.train.metrics.totalReturnPct,
    validationReturnPct: verdict.validation.metrics.totalReturnPct,
    testReturnPct: verdict.test.metrics.totalReturnPct,
    createdAt: Date.now(),
  });

  logger.info(
    { event: 'VERDICT_RECORDED', strategy: strat.name, version: strat.version, approved, flags: verdict.flags },
    'Strategy verdict recorded',
  );

  console.log(JSON.stringify({
    strategy: strat.name,
    version: strat.version,
    approved,
    flags: verdict.flags,
    summary: verdict.summary,
  }, null, 2));

  await closePool();
}

main().catch((err) => {
  logger.fatal({ err }, 'recordVerdict failed');
  process.exit(1);
});
