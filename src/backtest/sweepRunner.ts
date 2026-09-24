import { Strategy } from '../strategy/types';
import { SlippageModel } from './slippage';
import { StopConfig, PriceBar } from './types';
import { WalkForwardConfig, WalkForwardValidator } from './walkForward';

export interface SweepConfig<P> {
  name: string;
  params: P;
}

export interface SweepMintResult {
  mint: string;
  passed: boolean;
  testReturnPct: number;
  testWinRate: number;
  testTrades: number;
  flags: string[];
}

export interface SweepResult<P> {
  configName: string;
  params: P;
  perMint: SweepMintResult[];
  mintsPassed: number;
  mintsTested: number;
  avgTestReturnPct: number;
  avgTestWinRate: number;
  avgTestTrades: number;
  totalTrades: number;
  flags: string[];
}

export interface SweepOptions {
  minMintsPassedForCandidate: number;
  minTotalTradesForMeaningful: number;
}

export const defaultSweepOptions: SweepOptions = {
  minMintsPassedForCandidate: 2,
  minTotalTradesForMeaningful: 100,
};

/**
 * Rule 19: exhaustive parameter testing. Runs each config through the same
 * walk-forward validator across all mints, aggregates, ranks.
 *
 * Deterministic: given the same bars + grid, produces the same result.
 * No network. No execution. No orchestrator.
 */
export class ParameterSweeper<P> {
  constructor(
    private readonly strategyName: string,
    private readonly strategyFactory: (params: P) => Strategy,
    private readonly stopsFactory: (params: P) => StopConfig,
    private readonly baseWalkForwardConfig: Omit<WalkForwardConfig, 'stops' | 'slippageModel'>,
    private readonly options: SweepOptions = defaultSweepOptions,
  ) {}

  run(
    mintBars: Map<string, PriceBar[]>,
    grid: SweepConfig<P>[],
    slippageModel: SlippageModel,
    onProgress?: (done: number, total: number) => void,
  ): SweepResult<P>[] {
    const results: SweepResult<P>[] = [];
    for (let i = 0; i < grid.length; i++) {
      results.push(this.runOne(grid[i], mintBars, slippageModel));
      if (onProgress && (i + 1) % 25 === 0) onProgress(i + 1, grid.length);
    }
    results.sort(
      (a, b) => b.mintsPassed - a.mintsPassed || b.avgTestReturnPct - a.avgTestReturnPct,
    );
    return results;
  }

  private runOne(
    cfg: SweepConfig<P>,
    mintBars: Map<string, PriceBar[]>,
    slippageModel: SlippageModel,
  ): SweepResult<P> {
    const stops = this.stopsFactory(cfg.params);
    const perMint: SweepMintResult[] = [];
    let mintsPassed = 0;
    let sumReturn = 0;
    let sumWinRate = 0;
    let sumTrades = 0;
    let totalTrades = 0;

    for (const [mint, bars] of mintBars) {
      const strategy = this.strategyFactory(cfg.params);
      const validator = new WalkForwardValidator(strategy, {
        ...this.baseWalkForwardConfig,
        stops,
        slippageModel,
      });
      const verdict = validator.run(bars);
      const passed = verdict.flags.includes('EDGE_CONFIRMED');
      const testTrades = verdict.test.trades.length;
      perMint.push({
        mint,
        passed,
        testReturnPct: verdict.test.metrics.totalReturnPct,
        testWinRate: verdict.test.metrics.winRate,
        testTrades,
        flags: verdict.flags,
      });
      if (passed) mintsPassed++;
      sumReturn += verdict.test.metrics.totalReturnPct;
      sumWinRate += verdict.test.metrics.winRate;
      sumTrades += testTrades;
      totalTrades += testTrades;
    }

    const n = mintBars.size || 1;
    const result: SweepResult<P> = {
      configName: cfg.name,
      params: cfg.params,
      perMint,
      mintsPassed,
      mintsTested: mintBars.size,
      avgTestReturnPct: sumReturn / n,
      avgTestWinRate: sumWinRate / n,
      avgTestTrades: sumTrades / n,
      totalTrades,
      flags: [],
    };

    if (result.mintsPassed >= this.options.minMintsPassedForCandidate) {
      result.flags.push('MULTI_MINT_EDGE');
    }
    if (result.totalTrades >= this.options.minTotalTradesForMeaningful) {
      result.flags.push('STATISTICALLY_MEANINGFUL');
    }
    if (result.avgTestReturnPct > 0 && result.totalTrades >= this.options.minTotalTradesForMeaningful) {
      result.flags.push('POSITIVE_RETURN');
    }

    return result;
  }
}
