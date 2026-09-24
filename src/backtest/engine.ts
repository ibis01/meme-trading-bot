import { randomUUID } from 'crypto';
import { Strategy } from '../strategy/types';
import { BacktestConfig, BacktestResult, BacktestTrade, PriceBar } from './types';
import { computeMetrics } from './metrics';
import { SlippageModel, ConstantSlippageModel } from './slippage';

/**
 * Deterministic backtester. No network, no execution, no risk engine.
 * Rule 18: costs (fees + slippage) are always applied.
 * Rule 19: the split label is preserved so callers cannot mix datasets.
 * Rule 30: bars without a valid next price are skipped, never guessed.
 */
export class Backtester {
  private readonly slippageModel: SlippageModel;

  constructor(
    private readonly strategy: Strategy,
    private readonly config: BacktestConfig,
    slippageModel?: SlippageModel,
  ) {
    this.slippageModel = slippageModel ?? new ConstantSlippageModel(config.slippageRate);
  }

  run(bars: PriceBar[]): BacktestResult {
    const trades: BacktestTrade[] = [];
    const equityCurveSol: number[] = [];
    let equity = this.config.initialEquitySol;
    equityCurveSol.push(equity);
    let feesPaidSol = 0;
    let slippagePaidSol = 0;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (!bar.nextPriceUsd || bar.nextPriceUsd <= 0) {
        equityCurveSol.push(equity);
        continue;
      }

      const signal = this.strategy.evaluate(bar, {
        equitySol: equity,
        riskPerTradeSol: this.config.riskPerTradeSol,
        maxPositionSol: this.config.maxPositionSol,
      });

      if (!signal) {
        equityCurveSol.push(equity);
        continue;
      }

      const entry = bar.priceUsd;
      const exit = bar.nextPriceUsd;
      if (entry <= 0) {
        equityCurveSol.push(equity);
        continue;
      }

      const notional = Math.min(signal.proposedAmountSol, equity);
      const fee = notional * this.config.feeRate;
      const slipRate = this.slippageModel.compute({
        amountSol: notional,
        solPriceUsd: this.config.solPriceUsd ?? 200,
        liquidityUsd: bar.liquidityUsd,
      });
      const slip = notional * slipRate;
      feesPaidSol += fee;
      slippagePaidSol += slip;

      const grossReturn = (exit - entry) / entry;
      const netPnl = notional * grossReturn - fee - slip;
      const returnPct = notional > 0 ? (netPnl / notional) * 100 : 0;

      equity += netPnl;
      equityCurveSol.push(equity);

      trades.push({
        entryIndex: i,
        exitIndex: i + 1,
        tokenMint: bar.tokenMint,
        entryPriceUsd: entry,
        exitPriceUsd: exit,
        amountSol: notional,
        pnlSol: netPnl,
        returnPct,
        reason: signal.evidence.entryReason,
      });
    }

    const metrics = computeMetrics(
      trades,
      equityCurveSol,
      this.config.initialEquitySol,
      feesPaidSol,
      slippagePaidSol,
      bars.length,
    );

    // Rule 18: refuse to call it profitable if costs ate the edge.
    const grossPnlBeforeCosts = trades.reduce(
      (s, t) => s + t.pnlSol + (t.amountSol * this.config.feeRate) + (t.amountSol * this.config.slippageRate),
      0,
    );
    const profitableAfterCosts = metrics.totalReturnPct > 0 && grossPnlBeforeCosts > 0;

    return {
      split: this.config.split,
      bars: bars.length,
      trades,
      metrics,
      equityCurveSol,
      profitableAfterCosts,
    };
  }
}

export function newBacktestRunId(): string {
  return `bt_${randomUUID()}`;
}
