import { Strategy } from '../strategy/types';
import { WalkForwardFlag, WalkForwardValidator, WalkForwardConfig } from './walkForward';
import { PriceBar } from './types';

export interface SeedRunResult {
  seed: number;
  flags: WalkForwardFlag[];
  approved: boolean;
  tradesTotal: number;
  testReturnPct: number;
}

export interface RobustnessReport {
  strategyName: string;
  strategyVersion: string;
  runs: SeedRunResult[];
  passCount: number;
  totalRuns: number;
  passRate: number;
  requiredPassRate: number;
  verdict: 'ROBUST' | 'INSUFFICIENT_EVIDENCE' | 'NO_EDGE';
}

export interface SeedPathBuilder {
  seed: number;
  bars: number;
}

/**
 * Rule 19: a strategy that passes on ONE synthetic seed is noise.
 * Robustness requires a minimum pass rate across many independent seeds.
 */
export class SeedRobustnessRunner {
  constructor(
    private readonly strategyFactory: () => Strategy,
    private readonly pathBuilder: (seed: number, bars: number) => PriceBar[],
    private readonly walkForwardConfig: WalkForwardConfig,
    private readonly requiredPassRate: number = 0.7,
  ) {
    if (requiredPassRate < 0 || requiredPassRate > 1) {
      throw new Error('requiredPassRate must be in [0, 1]');
    }
  }

  run(builder: SeedPathBuilder, seeds: number[]): RobustnessReport {
    const runs: SeedRunResult[] = [];
    for (const seed of seeds) {
      const bars = this.pathBuilder(seed, builder.bars);
      const validator = new WalkForwardValidator(this.strategyFactory(), this.walkForwardConfig);
      const verdict = validator.run(bars);
      const tradesTotal =
        verdict.train.trades.length + verdict.validation.trades.length + verdict.test.trades.length;
      runs.push({
        seed,
        flags: verdict.flags,
        approved: verdict.flags.includes('EDGE_CONFIRMED'),
        tradesTotal,
        testReturnPct: verdict.test.metrics.totalReturnPct,
      });
    }

    const passCount = runs.filter((r) => r.approved).length;
    const passRate = runs.length > 0 ? passCount / runs.length : 0;

    let verdict: RobustnessReport['verdict'];
    if (passRate >= this.requiredPassRate) verdict = 'ROBUST';
    else if (passCount > 0) verdict = 'INSUFFICIENT_EVIDENCE';
    else verdict = 'NO_EDGE';

    const strat = this.strategyFactory();
    return {
      strategyName: strat.name,
      strategyVersion: strat.version,
      runs,
      passCount,
      totalRuns: runs.length,
      passRate,
      requiredPassRate: this.requiredPassRate,
      verdict,
    };
  }
}
