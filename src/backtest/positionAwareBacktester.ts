import { Strategy } from '../strategy/types';
import { ExitRules } from './exitRules';
import { computeMetrics } from './metrics';
import { SlippageModel, ConstantSlippageModel } from './slippage';
import {
  ClosedTrade,
  ExitReason,
  OpenPosition,
  PositionAwareBacktestConfig,
  PositionAwareBacktestResult,
  PriceBar,
} from './types';

/**
 * Rule 16: models real position lifecycle.
 *   - One position at a time (Rule 15 max-open-positions = 1 for backtest).
 *   - Entry on signal.
 *   - Exit only when exit rules fire, or at end of data.
 *   - Holds across bars.
 *
 * Deterministic. No I/O. Same bars + same strategy + same stops → same result.
 */
export class PositionAwareBacktester {
  private readonly exitRules: ExitRules;
  private readonly slippageModel: SlippageModel;

  constructor(
    private readonly strategy: Strategy,
    private readonly config: PositionAwareBacktestConfig,
    slippageModel?: SlippageModel,
  ) {
    this.exitRules = new ExitRules(config.stops);
    this.slippageModel = slippageModel ?? new ConstantSlippageModel(config.slippageRate);
  }

  run(bars: PriceBar[]): PositionAwareBacktestResult {
    const trades: ClosedTrade[] = [];
    const equityCurveSol: number[] = [];
    let equity = this.config.initialEquitySol;
    equityCurveSol.push(equity);
    let feesPaidSol = 0;
    let slippagePaidSol = 0;
    let position: OpenPosition | null = null;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      // We only need the current bar to be valid; the exit fill is at bar.priceUsd.
      if (!bar.priceUsd || bar.priceUsd <= 0) {
        equityCurveSol.push(equity);
        continue;
      }

      // --- Update HWM before any evaluation ---
      if (position) {
        position = this.exitRules.updateHighWatermark(position, bar.priceUsd);
      }

      // --- If holding: check exit rules ---
      if (position) {
        const decision = this.exitRules.evaluate(position, bar.priceUsd, bar.fetchedAt);
        if (decision.shouldExit) {
          equity = this.closePosition(position, bar, i, decision.reason!, trades, equity, feesPaidSol, slippagePaidSol, () => {
            feesPaidSol += 0; // fees tracked inside closePosition via closure
          });
          // Recompute feesPaid/slippage from trades for truth
          feesPaidSol = trades.reduce((s, t) => s + t.amountSol * this.config.feeRate, 0);
          slippagePaidSol = trades.reduce((s, t) => s + t.amountSol * this.config.slippageRate, 0);
          position = null;
          equityCurveSol.push(equity);
          continue;
        }
        equityCurveSol.push(equity);
        continue;
      }

      // --- Flat: evaluate entry ---
      const signal = this.strategy.evaluate(bar, {
        equitySol: equity,
        riskPerTradeSol: this.config.riskPerTradeSol,
        maxPositionSol: this.config.maxPositionSol,
      });

      if (!signal) {
        equityCurveSol.push(equity);
        continue;
      }

      const notional = Math.min(signal.proposedAmountSol, equity);
      if (notional <= 0 || bar.priceUsd <= 0) {
        equityCurveSol.push(equity);
        continue;
      }

      // Entry fee + slippage charged immediately.
      const entryFee = notional * this.config.feeRate;
      const entrySlipRate = this.slippageModel.compute({
        amountSol: notional,
        solPriceUsd: this.config.solPriceUsd ?? 200,
        liquidityUsd: bar.liquidityUsd,
      });
      const entrySlip = notional * entrySlipRate;
      feesPaidSol += entryFee;
      slippagePaidSol += entrySlip;

      position = {
        tokenMint: bar.tokenMint,
        entryIndex: i,
        entryPriceUsd: bar.priceUsd,
        entryAt: bar.fetchedAt,
        amountSol: notional,
        highWatermarkUsd: bar.priceUsd,
      };
      equityCurveSol.push(equity);
    }

    // --- Close any remaining position at the last bar ---
    if (position && bars.length > 0) {
      const lastBar = bars[bars.length - 1];
      const lastIndex = bars.length - 1;
      equity = this.closePosition(position, lastBar, lastIndex, 'END_OF_DATA', trades, equity, feesPaidSol, slippagePaidSol, () => {});
      feesPaidSol = trades.reduce((s, t) => s + t.amountSol * this.config.feeRate, 0);
      slippagePaidSol = trades.reduce((s, t) => s + t.amountSol * this.config.slippageRate, 0);
    }

    // Ensure equity curve ends at final value.
    if (equityCurveSol[equityCurveSol.length - 1] !== equity) {
      equityCurveSol.push(equity);
    }

    const metrics = computeMetrics(
      trades,
      equityCurveSol,
      this.config.initialEquitySol,
      feesPaidSol,
      slippagePaidSol,
      bars.length,
    );

    const grossPnlBeforeCosts = trades.reduce(
      (s, t) =>
        s + t.pnlSol
        + t.amountSol * this.config.feeRate * 2  // entry + exit
        + t.amountSol * this.config.slippageRate * 2,
      0,
    );

    return {
      split: this.config.split,
      bars: bars.length,
      trades,
      metrics,
      equityCurveSol,
      profitableAfterCosts: metrics.totalReturnPct > 0 && grossPnlBeforeCosts > 0,
    };
  }

  private closePosition(
    position: OpenPosition,
    bar: PriceBar,
    barIndex: number,
    reason: ExitReason,
    trades: ClosedTrade[],
    equity: number,
    _feesSoFar: number,
    _slipSoFar: number,
    _onClose: () => void,
  ): number {
    // Rule 18: exit fill is the price on the bar where the stop triggered,
    // NOT the next bar's price. Using nextPriceUsd here is future data.
    const exit = bar.priceUsd;
    const entry = position.entryPriceUsd;
    const grossReturn = (exit - entry) / entry;

    // Exit-side fees and slippage.
    const exitFee = position.amountSol * this.config.feeRate;
    const exitSlipRate = this.slippageModel.compute({
      amountSol: position.amountSol,
      solPriceUsd: this.config.solPriceUsd ?? 200,
      liquidityUsd: bar.liquidityUsd,
    });
    const exitSlip = position.amountSol * exitSlipRate;

    // Total PnL = notional × grossReturn − entry(fee+slip) − exit(fee+slip).
    // Use per-side rates on each side (approximated here as one aggregate).
    const totalCosts = exitFee + exitSlip + position.amountSol * (this.config.feeRate + exitSlipRate);
    const netPnl = position.amountSol * grossReturn - totalCosts;
    const returnPct = position.amountSol > 0 ? (netPnl / position.amountSol) * 100 : 0;

    trades.push({
      entryIndex: position.entryIndex,
      exitIndex: barIndex,
      tokenMint: position.tokenMint,
      entryPriceUsd: entry,
      exitPriceUsd: exit,
      amountSol: position.amountSol,
      pnlSol: netPnl,
      returnPct,
      reason: reason,
      exitReason: reason,
      holdBars: barIndex - position.entryIndex,
    });

    return equity + netPnl;
  }
}
