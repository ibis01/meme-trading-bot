import fs from 'fs';
import path from 'path';
import { WalkForwardValidator, defaultWalkForwardConfig, defaultStops } from '../backtest/walkForward';
import { selectSlippageModel } from '../backtest/slippageFactory';
import { BirdeyeHistoryProvider } from '../data/birdeyeHistory';
import { PostgresBarStore, linkNextPrices } from '../state/bars';
import { resampleBars, INTERVAL_NAMES } from '../backtest/resample';
import { MomentumStrategy, defaultMomentumConfig } from '../strategy/momentum';
import { MeanReversionStrategy, defaultMeanReversionConfig } from '../strategy/meanReversion';
import { AlwaysBuyStrategy, HoldNothingStrategy, SeededRandomStrategy } from '../strategy/baselines';
import { Strategy } from '../strategy/types';
import { BacktestResult } from '../backtest/types';
import { getPool, closePool } from '../infra/db';
import { config } from '../config';
import { logger } from '../utils/logger';

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const SOURCE_INTERVAL_MS = 60_000; // Birdeye backfill granularity
const RECORDED_INTERVAL_MS = 30_000; // runRecorder.ts cadence

interface MintResult {
  mint: string;
  bars: number;
  strategies: {
    name: string;
    version: string;
    flags: string[];
    passed: boolean;
    train: WindowSummary;
    validation: WindowSummary;
    test: WindowSummary;
  }[];
}

interface WindowSummary {
  trades: number;
  returnPct: number;
  winRate: number;
  maxDrawdownPct: number;
  profitableAfterCosts: boolean;
  /** Distribution of exit reasons, only meaningful for position-aware backtests. */
  exitReasons?: Record<string, number>;
}

interface Aggregate {
  strategy: string;
  version: string;
  mintsTested: number;
  mintsPassed: number;
  avgTestReturnPct: number;
  avgTestWinRate: number;
  avgTestTrades: number;
  exitReasons: Record<string, number>;
}

function parseArgs(): { mints: string[]; slippageMode: string | undefined; intervalMs: number; intervalName: string } {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const explicit = get('mints');
  const intervalName = get('interval') ?? '1m';
  const intervalMs = INTERVAL_NAMES[intervalName];
  if (!intervalMs) throw new Error(`Unsupported --interval: ${intervalName}. Use 1m, 5m, 15m, 1h`);

  if (explicit) {
    return {
      mints: explicit.split(',').map((s) => s.trim()).filter(Boolean),
      slippageMode: get('slippage') ?? process.env.SLIPPAGE_MODEL,
      intervalMs,
      intervalName,
    };
  }
  const file = path.resolve(process.cwd(), 'mints.txt');
  if (!fs.existsSync(file)) throw new Error('mints.txt not found and --mints not provided');
  const mints = fs.readFileSync(file, 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return { mints, slippageMode: process.env.SLIPPAGE_MODEL, intervalMs, intervalName };
}

function summarise(r: BacktestResult): WindowSummary {
  const exitReasons: Record<string, number> = {};
  for (const t of r.trades) {
    const reason = (t as { exitReason?: string }).exitReason ?? 'UNKNOWN';
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
  }
  return {
    trades: r.trades.length,
    returnPct: round4(r.metrics.totalReturnPct),
    winRate: round4(r.metrics.winRate),
    maxDrawdownPct: round4(r.metrics.maxDrawdownPct),
    profitableAfterCosts: r.profitableAfterCosts,
    exitReasons,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function evaluate(
  strategy: Strategy,
  bars: ReturnType<typeof linkNextPrices>,
  slippageMode: string | undefined,
): MintResult['strategies'][number] {
  const slippageModel = selectSlippageModel(
    slippageMode,
    defaultWalkForwardConfig.backtest.slippageRate,
  );
  const validator = new WalkForwardValidator(strategy, {
    ...defaultWalkForwardConfig,
    stops: defaultStops,
    slippageModel,
  });
  const verdict = validator.run(bars);
  return {
    name: strategy.name,
    version: strategy.version,
    flags: verdict.flags,
    passed: verdict.flags.includes('EDGE_CONFIRMED'),
    train: summarise(verdict.train),
    validation: summarise(verdict.validation),
    test: summarise(verdict.test),
  };
}

async function evaluateMint(
  mint: string,
  backfill: boolean,
  slippageMode: string | undefined,
  intervalMs: number,
  store: PostgresBarStore,
): Promise<MintResult | null> {
  // Backfill is skipped when Birdeye is out of quota; existing 1m bars are resampled below.
  if (backfill && config.BIRDEYE_API_KEY) {
    const provider = new BirdeyeHistoryProvider({ apiKey: config.BIRDEYE_API_KEY });
    const now = Date.now();
    const bars = await provider.fetchBars(mint, now - LOOKBACK_MS, now, SOURCE_INTERVAL_MS);
    if (bars.length > 0) await store.saveMany(bars);
  }

  const raw = await store.get(mint, Date.now() - LOOKBACK_MS * 2, Date.now() + 60_000);
  // Always bucket by time: stored bars are a mix of 30s recorded and 1m backfilled.
  const working = resampleBars(raw, intervalMs, RECORDED_INTERVAL_MS);
  const linked = linkNextPrices(working, intervalMs * 3);
  if (linked.length < 100) {
    logger.warn({ mint, bars: linked.length }, 'Skipping mint — insufficient bars');
    return null;
  }

  const candidates: Strategy[] = [
    new HoldNothingStrategy(),
    new AlwaysBuyStrategy(0.1),
    new SeededRandomStrategy(12345, 0.15, 0.1),
    new MomentumStrategy(defaultMomentumConfig),
    new MeanReversionStrategy(defaultMeanReversionConfig),
  ];

  return {
    mint,
    bars: linked.length,
    strategies: candidates.map((s) => evaluate(s, linked, slippageMode)),
  };
}

function aggregate(results: MintResult[]): Aggregate[] {
  const byName = new Map<string, Aggregate>();
  for (const r of results) {
    for (const s of r.strategies) {
      const key = `${s.name}@${s.version}`;
      let agg = byName.get(key);
      if (!agg) {
        agg = {
          strategy: s.name,
          version: s.version,
          mintsTested: 0,
          mintsPassed: 0,
          avgTestReturnPct: 0,
          avgTestWinRate: 0,
          avgTestTrades: 0,
          exitReasons: {},
        };
        byName.set(key, agg);
      }
      agg.mintsTested += 1;
      if (s.passed) agg.mintsPassed += 1;
      agg.avgTestReturnPct += s.test.returnPct;
      agg.avgTestWinRate += s.test.winRate;
      agg.avgTestTrades += s.test.trades;
      for (const [k, v] of Object.entries(s.test.exitReasons ?? {})) {
        agg.exitReasons[k] = (agg.exitReasons[k] ?? 0) + v;
      }
    }
  }
  const out: Aggregate[] = [];
  for (const agg of byName.values()) {
    if (agg.mintsTested > 0) {
      agg.avgTestReturnPct = round4(agg.avgTestReturnPct / agg.mintsTested);
      agg.avgTestWinRate = round4(agg.avgTestWinRate / agg.mintsTested);
      agg.avgTestTrades = round4(agg.avgTestTrades / agg.mintsTested);
    }
    out.push(agg);
  }
  // Sort: most mints passed first, then highest avg return.
  out.sort((a, b) => b.mintsPassed - a.mintsPassed || b.avgTestReturnPct - a.avgTestReturnPct);
  return out;
}

async function main() {
  if (!config.DATABASE_URL) {
    logger.fatal('DATABASE_URL required');
    process.exit(1);
  }
  const { mints, slippageMode, intervalMs, intervalName } = parseArgs();
  if (mints.length === 0) {
    logger.fatal('No mints to evaluate');
    process.exit(1);
  }

  const backfill = process.env.SKIP_BACKFILL !== '1';
  logger.info({ mints: mints.length, backfill, slippageMode: slippageMode ?? 'constant', interval: intervalName }, 'Multi-mint evaluation starting');

  const store = new PostgresBarStore(getPool());
  const results: MintResult[] = [];
  for (const mint of mints) {
    try {
      const r = await evaluateMint(mint, backfill, slippageMode, intervalMs, store);
      if (r) results.push(r);
    } catch (err) {
      logger.error({ mint, err }, 'Mint evaluation failed');
    }
  }

  console.log(JSON.stringify({
    mintsEvaluated: results.length,
    slippageModel: slippageMode ?? 'constant',
    interval: intervalName,
    aggregates: aggregate(results),
    perMint: results.map((r) => ({
      mint: r.mint,
      bars: r.bars,
      strategies: r.strategies.map((s) => ({
        name: s.name,
        version: s.version,
        passed: s.passed,
        flags: s.flags,
        testTrades: s.test.trades,
        testReturnPct: s.test.returnPct,
        testWinRate: s.test.winRate,
        exitReasons: s.test.exitReasons,
      })),
    })),
  }, null, 2));

  await closePool();
}

main().catch((err) => {
  logger.fatal({ err }, 'multi-mint evaluation failed');
  process.exit(1);
});
