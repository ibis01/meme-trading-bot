import { SeedRobustnessRunner } from '../backtest/seedRobustness';
import { WalkForwardConfig, defaultWalkForwardConfig } from '../backtest/walkForward';
import { syntheticStops } from '../backtest/stopPresets';
import { selectSlippageModel } from '../backtest/slippageFactory';
import { PriceBar } from '../backtest/types';
import { generatePath } from '../scripts/seedDemoBars';
import { MomentumStrategy, syntheticMomentumConfig } from '../strategy/momentum';
import {
  AlwaysBuyStrategy,
  HoldNothingStrategy,
  SeededRandomStrategy,
} from '../strategy/baselines';
import { Strategy } from '../strategy/types';

const BARS = Number(process.env.ROBUST_BARS ?? 3000);
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const TOKEN_MINT = 'ROBUST_MINT';

function pctChange(prices: number[], i: number, lookback: number): number {
  const from = Math.max(0, i - lookback);
  if (i === from) return 0;
  return ((prices[i] - prices[from]) / prices[from]) * 100;
}

/** Build a bar array from a synthetic seed. */
function buildBars(seed: number, count: number): PriceBar[] {
  const prices = generatePath(count, seed);
  const now = Date.now();
  return prices.slice(0, -1).map((p, i) => ({
    tokenMint: TOKEN_MINT,
    fetchedAt: now - (count - i) * 60_000,
    priceUsd: p,
    nextPriceUsd: prices[i + 1],
    liquidityUsd: 200_000,
    volume24hUsd: 1_000_000,
    holderCount: 3_000,
    top10HolderPercent: 22,
    smartWalletNetFlowUsd: 5_000,
    priceChange5mPercent: pctChange(prices, i, 5),
    priceChange1hPercent: pctChange(prices, i, 60),
  }));
}

function runFor(name: string, factory: () => Strategy, cfg: WalkForwardConfig) {
  const runner = new SeedRobustnessRunner(factory, buildBars, cfg, 0.7);
  return runner.run({ seed: 0, bars: BARS }, SEEDS);
}

function main() {
  const cfg: WalkForwardConfig = {
    ...defaultWalkForwardConfig,
    stops: syntheticStops,
    slippageModel: selectSlippageModel(
      process.env.SLIPPAGE_MODEL,
      defaultWalkForwardConfig.backtest.slippageRate,
    ),
  };

  const reports = [
    runFor('HOLD_NOTHING', () => new HoldNothingStrategy(), cfg),
    runFor('ALWAYS_BUY', () => new AlwaysBuyStrategy(0.1), cfg),
    runFor('SEEDED_RANDOM', () => new SeededRandomStrategy(42, 0.15, 0.1), cfg),
    runFor('MEME_MOMENTUM_V1', () => new MomentumStrategy(syntheticMomentumConfig), cfg),
  ];

  console.log(JSON.stringify({
    bars: BARS,
    seeds: SEEDS,
    requiredPassRate: 0.7,
    reports: reports.map((r) => ({
      strategy: r.strategyName,
      version: r.strategyVersion,
      verdict: r.verdict,
      passCount: r.passCount,
      totalRuns: r.totalRuns,
      passRate: round4(r.passRate),
      runs: r.runs.map((run) => ({
        seed: run.seed,
        approved: run.approved,
        tradesTotal: run.tradesTotal,
        testReturnPct: round4(run.testReturnPct),
        flags: run.flags,
      })),
    })),
  }, null, 2));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

main();
