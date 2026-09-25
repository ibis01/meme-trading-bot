import fs from 'fs';
import path from 'path';
import { getPool, closePool } from '../infra/db';
import { PostgresBarStore, linkNextPrices } from '../state/bars';
import { resampleBars, INTERVAL_NAMES } from '../backtest/resample';
import { ParameterSweeper, SweepConfig, SweepResult } from '../backtest/sweepRunner';
import { selectSlippageModel } from '../backtest/slippageFactory';
import { defaultWalkForwardConfig } from '../backtest/walkForward';
import { PriceBar } from '../backtest/types';
import { MomentumStrategy } from '../strategy/momentum';
import { MeanReversionStrategy } from '../strategy/meanReversion';
import { config } from '../config';
import { logger } from '../utils/logger';

interface MomentumParams {
  min5mChangePercent: number;
  min1hChangePercent: number;
  hardStopPct: number;
  trailingStopPct: number;
  timeStopBars: number;
}

interface MeanRevParams {
  max5mChangePercent: number;
  max1hChangePercent: number;
  hardStopPct: number;
  trailingStopPct: number;
  timeStopBars: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const intervalName = get('interval') ?? '15m';
  const intervalMs = INTERVAL_NAMES[intervalName];
  if (!intervalMs) throw new Error(`Unsupported interval: ${intervalName}. Use 1m/5m/15m/1h`);
  const lookback = get('last') ?? '7d';
  const m = /^(\d+)([smhd])$/.exec(lookback);
  if (!m) throw new Error(`Invalid --last: ${lookback}`);
  const n = Number(m[1]);
  const mult = m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
  const lookbackMs = n * mult;
  const strategyFilter = get('strategy');
  const out = get('out') ?? 'sweep-results.json';
  const explicit = get('mints');
  const mints = explicit
    ? explicit.split(',').map((s) => s.trim()).filter(Boolean)
    : (() => {
        const file = path.resolve(process.cwd(), 'mints.txt');
        if (!fs.existsSync(file)) throw new Error('mints.txt not found and --mints not provided');
        return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      })();
  return { intervalName, intervalMs, lookbackMs, strategyFilter, out, mints };
}

function momentumGrid(_intervalMs: number): SweepConfig<MomentumParams>[] {
  const grid: SweepConfig<MomentumParams>[] = [];
  for (const min5m of [0.3, 0.5, 0.8, 1.2]) {
    for (const min1h of [0.5, 1.0, 1.5]) {
      for (const hard of [0.02, 0.03, 0.05]) {
        for (const trail of [0.01, 0.02]) {
          for (const bars of [4, 8, 16]) {
            const params: MomentumParams = {
              min5mChangePercent: min5m, min1hChangePercent: min1h,
              hardStopPct: hard, trailingStopPct: trail, timeStopBars: bars,
            };
            grid.push({ name: `m_${min5m}_${min1h}_h${hard}_t${trail}_${bars}b`, params });
          }
        }
      }
    }
  }
  return grid;
}

function meanRevGrid(_intervalMs: number): SweepConfig<MeanRevParams>[] {
  const grid: SweepConfig<MeanRevParams>[] = [];
  for (const dip5m of [-0.2, -0.4, -0.6, -0.8]) {
    for (const dip1h of [-0.4, -0.8, -1.2]) {
      for (const hard of [0.02, 0.03, 0.05]) {
        for (const trail of [0.01, 0.02]) {
          for (const bars of [4, 8, 16]) {
            const params: MeanRevParams = {
              max5mChangePercent: dip5m, max1hChangePercent: dip1h,
              hardStopPct: hard, trailingStopPct: trail, timeStopBars: bars,
            };
            grid.push({ name: `mr_${dip5m}_${dip1h}_h${hard}_t${trail}_${bars}b`, params });
          }
        }
      }
    }
  }
  return grid;
}

async function loadBars(
  mints: string[],
  intervalMs: number,
  lookbackMs: number,
): Promise<Map<string, PriceBar[]>> {
  const store = new PostgresBarStore(getPool());
  const map = new Map<string, PriceBar[]>();
  const now = Date.now();
  for (const mint of mints) {
    const raw = await store.get(mint, now - lookbackMs * 2, now + 60_000);
    if (raw.length < 100) {
      logger.warn({ mint, bars: raw.length }, 'Skipping mint — insufficient bars');
      continue;
    }
    const resampled = intervalMs === 60_000 ? raw : resampleBars(raw, intervalMs, 60_000);
    const linked = linkNextPrices(resampled);
    map.set(mint, linked);
    logger.info({ mint: mint.slice(0, 8) + '…', bars: linked.length }, 'Loaded bars');
  }
  return map;
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }

function summarize<P>(r: SweepResult<P>) {
  return {
    config: r.configName,
    params: r.params as unknown as Record<string, number>,
    mintsPassed: r.mintsPassed,
    mintsTested: r.mintsTested,
    avgTestReturnPct: round4(r.avgTestReturnPct),
    avgTestWinRate: round4(r.avgTestWinRate),
    avgTestTrades: round4(r.avgTestTrades),
    totalTrades: r.totalTrades,
    flags: r.flags,
    perMint: r.perMint.map((p) => ({
      mint: p.mint.slice(0, 8) + '…',
      passed: p.passed,
      returnPct: round4(p.testReturnPct),
      winRate: round4(p.testWinRate),
      trades: p.testTrades,
    })),
  };
}

async function main() {
  if (!config.DATABASE_URL) { logger.fatal('DATABASE_URL required'); process.exit(1); }
  const args = parseArgs();
  logger.info(
    { mints: args.mints.length, interval: args.intervalName, strategy: args.strategyFilter ?? 'both' },
    'Parameter sweep starting',
  );

  const bars = await loadBars(args.mints, args.intervalMs, args.lookbackMs);
  if (bars.size === 0) { logger.fatal('No mints with sufficient bars'); process.exit(1); }

  const slippageModel = selectSlippageModel(process.env.SLIPPAGE_MODEL, 0.003);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { stops: _ignored, ...baseWf } = defaultWalkForwardConfig;

  const output = {
    interval: args.intervalName,
    slippageModel: process.env.SLIPPAGE_MODEL ?? 'constant',
    mintsTested: bars.size,
    strategies: [] as Array<{
      strategy: string;
      configsTested: number;
      positiveReturnConfigs: number;
      leaderboard: ReturnType<typeof summarize>[];
    }>,
  };

  if (!args.strategyFilter || args.strategyFilter === 'momentum') {
    logger.info('Running momentum sweep');
    const grid = momentumGrid(args.intervalMs);
    const sweeper = new ParameterSweeper<MomentumParams>(
      'MEME_MOMENTUM_V1',
      (p) => new MomentumStrategy({
        min5mChangePercent: p.min5mChangePercent,
        min1hChangePercent: p.min1hChangePercent,
        requirePositiveSmartFlow: false,
        stopDistancePercent: 15,
      }),
      (p) => ({ hardStopPct: p.hardStopPct, trailingStopPct: p.trailingStopPct, timeStopMs: p.timeStopBars * args.intervalMs }),
      baseWf,
    );
    const results = sweeper.run(bars, grid, slippageModel, (done, total) =>
      logger.info({ done, total }, 'momentum sweep progress'),
    );
    output.strategies.push({
      strategy: 'MEME_MOMENTUM_V1',
      configsTested: grid.length,
      positiveReturnConfigs: results.filter((r) => r.avgTestReturnPct > 0).length,
      leaderboard: results.slice(0, 20).map(summarize),
    });
  }

  if (!args.strategyFilter || args.strategyFilter === 'meanrev') {
    logger.info('Running mean-reversion sweep');
    const grid = meanRevGrid(args.intervalMs);
    const sweeper = new ParameterSweeper<MeanRevParams>(
      'MEME_MEANREV_V1',
      (p) => new MeanReversionStrategy({
        max5mChangePercent: p.max5mChangePercent,
        max1hChangePercent: p.max1hChangePercent,
        stopDistancePercent: 3,
      }),
      (p) => ({ hardStopPct: p.hardStopPct, trailingStopPct: p.trailingStopPct, timeStopMs: p.timeStopBars * args.intervalMs }),
      baseWf,
    );
    const results = sweeper.run(bars, grid, slippageModel, (done, total) =>
      logger.info({ done, total }, 'meanrev sweep progress'),
    );
    output.strategies.push({
      strategy: 'MEME_MEANREV_V1',
      configsTested: grid.length,
      positiveReturnConfigs: results.filter((r) => r.avgTestReturnPct > 0).length,
      leaderboard: results.slice(0, 20).map(summarize),
    });
  }

  fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
  logger.info({ out: args.out }, 'Full sweep results written');

  console.log(JSON.stringify({
    interval: output.interval,
    slippageModel: output.slippageModel,
    mintsTested: output.mintsTested,
    strategies: output.strategies.map((s) => ({
      strategy: s.strategy,
      configsTested: s.configsTested,
      positiveReturnConfigs: s.positiveReturnConfigs,
      topConfigs: s.leaderboard.slice(0, 5),
    })),
  }, null, 2));

  await closePool();
}

main().catch((err) => { logger.fatal({ err }, 'sweep failed'); process.exit(1); });
