import { Strategy } from '../strategy/types';
import { BacktestConfig, BacktestResult, PriceBar, StopConfig } from './types';
import { Backtester } from './engine';
import { PositionAwareBacktester } from './positionAwareBacktester';
import { SlippageModel } from './slippage';

export interface WalkForwardConfig {
  trainFraction: number;
  validationFraction: number;
  backtest: Omit<BacktestConfig, 'split'>;
  stops?: StopConfig;
  /** Rule 18: optional slippage model. Defaults to ConstantSlippageModel(backtest.slippageRate). */
  slippageModel?: SlippageModel;
  /**
   * Rule 19: minimum trades required in EACH window for EDGE_CONFIRMED.
   * Must be consistent with (bars per window / bars per hold).
   * For 1-min bars and a 30-min time stop: max ~30 trades per 1000-bar window.
   */
  minTradesPerWindow: number;
  /** Rule 19: minimum trades required in total across all windows. */
  minTradesTotal: number;
}

export const defaultWalkForwardConfig: WalkForwardConfig = {
  trainFraction: 0.6,
  validationFraction: 0.2,
  backtest: {
    feeRate: 0.002,
    slippageRate: 0.003,
    initialEquitySol: 10,
    riskPerTradeSol: 0.1,
    maxPositionSol: 0.1,
  },
  // Calibrated for 5000-bar datasets with a 30-min hold on 1-min bars:
  // test window = 1000 bars, max ~30 trades if always-in. Require half.
  minTradesPerWindow: 15,
  minTradesTotal: 60,
};

// Default stops now point at the real-data preset. Synthetic runs must
// opt in explicitly via syntheticStops (see stopPresets.ts).
export { realDataStops as defaultStops } from './stopPresets';

export type WalkForwardFlag =
  | 'INSUFFICIENT_DATA'
  | 'NO_TRADES'
  | 'NO_TRADES'
  | 'INSUFFICIENT_SAMPLE'
  | 'OVERFIT_TRAIN_ONLY'
  | 'FRAGILE_VALIDATION_MISMATCH'
  | 'COST_INVALIDATED'
  | 'EDGE_CONFIRMED'
  | 'NO_EDGE';

export interface WalkForwardVerdict {
  flags: WalkForwardFlag[];
  train: BacktestResult;
  validation: BacktestResult;
  test: BacktestResult;
  summary: string;
}

export class WalkForwardValidator {
  constructor(
    private readonly strategy: Strategy,
    private readonly config: WalkForwardConfig = defaultWalkForwardConfig,
  ) {
    const total = config.trainFraction + config.validationFraction;
    if (total >= 1 || total <= 0) {
      throw new Error('trainFraction + validationFraction must be in (0, 1)');
    }
    if (config.minTradesPerWindow < 0 || config.minTradesTotal < 0) {
      throw new Error('minTrades* must be >= 0');
    }
  }

  run(bars: PriceBar[]): WalkForwardVerdict {
    const n = bars.length;
    const trainEnd = Math.floor(n * this.config.trainFraction);
    const valEnd = Math.floor(n * (this.config.trainFraction + this.config.validationFraction));

    const MIN_WINDOW = 20;
    const insufficient =
      trainEnd < MIN_WINDOW ||
      valEnd - trainEnd < MIN_WINDOW ||
      n - valEnd < MIN_WINDOW;

    if (insufficient) {
      return {
        flags: ['INSUFFICIENT_DATA'],
        train: this.runWindow([], 'train'),
        validation: this.runWindow([], 'validation'),
        test: this.runWindow([], 'test'),
        summary: `Not enough bars for walk-forward (need ≥ ${MIN_WINDOW} per window, got ${n}).`,
      };
    }

    const train = this.runWindow(bars.slice(0, trainEnd), 'train');
    const validation = this.runWindow(bars.slice(trainEnd, valEnd), 'validation');
    const test = this.runWindow(bars.slice(valEnd), 'test');

    const flags = this.classify(train, validation, test);
    return { flags, train, validation, test, summary: this.summarize(flags, train, validation, test) };
  }

  private runWindow(bars: PriceBar[], split: BacktestConfig['split']): BacktestResult {
    if (this.config.stops) {
      const bt = new PositionAwareBacktester(
        this.strategy,
        { ...this.config.backtest, stops: this.config.stops, split },
        this.config.slippageModel,
      );
      return bt.run(bars);
    }
    return new Backtester(
      this.strategy,
      { ...this.config.backtest, split },
      this.config.slippageModel,
    ).run(bars);
  }

  private classify(
    train: BacktestResult,
    validation: BacktestResult,
    test: BacktestResult,
  ): WalkForwardFlag[] {
    const flags: WalkForwardFlag[] = [];

    // Rule 19: no trades at all is a distinct outcome from an unprofitable strategy.
    if (train.trades.length + validation.trades.length + test.trades.length === 0) {
      flags.push('NO_TRADES');
      return flags;
    }

    // Rule 19: no trades at all is a distinct outcome from an unprofitable strategy.
    if (train.trades.length + validation.trades.length + test.trades.length === 0) {
      flags.push('NO_TRADES');
      return flags;
    }

    const trainProfitable = train.profitableAfterCosts;
    const valProfitable = validation.profitableAfterCosts;
    const testProfitable = test.profitableAfterCosts;

    // Rule 19: cost-invalidation takes priority — nothing can be claimed if everything loses.
    const allInvalidated =
      !trainProfitable && !valProfitable && !testProfitable &&
      train.trades.length + validation.trades.length + test.trades.length > 0;
    if (allInvalidated) {
      flags.push('COST_INVALIDATED');
      return flags;
    }

    // Rule 19: statistical significance. Without enough trades, EDGE_CONFIRMED is meaningless.
    const perWindowOk =
      train.trades.length >= this.config.minTradesPerWindow &&
      validation.trades.length >= this.config.minTradesPerWindow &&
      test.trades.length >= this.config.minTradesPerWindow;
    const totalOk =
      train.trades.length + validation.trades.length + test.trades.length >= this.config.minTradesTotal;

    if (!perWindowOk || !totalOk) {
      flags.push('INSUFFICIENT_SAMPLE');
    }

    if (trainProfitable && !testProfitable) flags.push('OVERFIT_TRAIN_ONLY');
    if (trainProfitable && !valProfitable) flags.push('FRAGILE_VALIDATION_MISMATCH');

    // Rule 19: EDGE_CONFIRMED requires profitability AND statistical significance.
    if (trainProfitable && valProfitable && testProfitable && perWindowOk && totalOk) {
      flags.push('EDGE_CONFIRMED');
      return flags;
    }

    if (flags.length === 0) flags.push('NO_EDGE');
    return flags;
  }

  private summarize(
    flags: WalkForwardFlag[],
    train: BacktestResult,
    validation: BacktestResult,
    test: BacktestResult,
  ): string {
    if (flags.includes('NO_TRADES')) {
      return 'Strategy never entered a position. Nothing to evaluate.';
    }
    if (flags.includes('NO_TRADES')) {
      return 'Strategy never entered a position. Nothing to evaluate.';
    }
    if (flags.includes('EDGE_CONFIRMED')) {
      return 'Edge survived train, validation, and test after costs, with sufficient sample size.';
    }
    if (flags.includes('COST_INVALIDATED')) {
      return 'All windows lost money after fees and slippage. No tradable edge.';
    }
    if (flags.includes('INSUFFICIENT_SAMPLE')) {
      const counts = `${train.trades.length}/${validation.trades.length}/${test.trades.length}`;
      return `Sample size below threshold (train/val/test trades: ${counts}; need ≥ ${this.config.minTradesPerWindow} per window, ≥ ${this.config.minTradesTotal} total). Results are not statistically meaningful.`;
    }
    if (flags.includes('OVERFIT_TRAIN_ONLY')) {
      return 'Profitable on train but not on test. Likely overfit — do not promote.';
    }
    if (flags.includes('FRAGILE_VALIDATION_MISMATCH')) {
      return 'Train looks good but validation does not. Parameter fragility likely.';
    }
    return 'No durable edge detected.';
  }
}
