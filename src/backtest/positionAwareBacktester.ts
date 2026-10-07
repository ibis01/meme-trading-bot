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

const DEFAULT_MAX_EXIT_DEFER_BARS = 6;

/** Rule 30: liquidity is "known" only if it is a finite number > 0. */
function hasKnownLiquidity(liquidityUsd: number | undefined): liquidityUsd is number {
  return typeof liquidityUsd === 'number' && Number.isFinite(liquidityUsd) && liquidityUsd > 0;
}

/**
 * Rule 16: models real position lifecycle.
 *   - One position at a time (Rule 15).
 *   - Entry only on a bar with known liquidity.
 *   - Exit only when exit rules fire, on a bar whose liquidity and modelled
 *     slippage clear the configured exit gates.
 *   - Rule 30: an unusable exit bar is deferred. If no usable bar appears
 *     within maxExitDeferBars, price at the last known-good bar and tag
 *     EXIT_FORCED_STALE so callers can exclude it from stats.
 *
 * Deterministic. No I/O.
 */
export class PositionAwareBacktester {
  private readonly exitRules: ExitRules;
  private readonly slippageModel: SlippageModel;
  private readonly maxExitDeferBars: number;
  private readonly minExitLiquidityUsd: number;
  private readonly maxExitSlippageRate: number;

  constructor(
    private readonly strategy: Strategy,
    private readonly config: PositionAwareBacktestConfig,
    slippageModel?: SlippageModel,
  ) {
    this.exitRules = new ExitRules(config.stops);
    this.slippageModel = slippageModel ?? new ConstantSlippageModel(config.slippageRate);
    const m = config.maxExitDeferBars ?? DEFAULT_MAX_EXIT_DEFER_BARS;
    if (!Number.isFinite(m) || m < 0) throw new Error('maxExitDeferBars must be >= 0');
    this.maxExitDeferBars = m;
    const minLiq = config.minExitLiquidityUsd ?? 0;
    if (!Number.isFinite(minLiq) || minLiq < 0) throw new Error('minExitLiquidityUsd must be >= 0');
    this.minExitLiquidityUsd = minLiq;
    const maxSlip = config.maxExitSlippageRate ?? 1;
    if (!Number.isFinite(maxSlip) || maxSlip <= 0) throw new Error('maxExitSlippageRate must be > 0');
    this.maxExitSlippageRate = maxSlip;
  }

  /** Rule 30: a bar is usable for exit only if liquidity and slippage clear the gates. */
  private canExitOn(bar: PriceBar, position: OpenPosition): boolean {
    if (!hasKnownLiquidity(bar.liquidityUsd)) return false;
    if (bar.liquidityUsd < this.minExitLiquidityUsd) return false;
    if (this.maxExitSlippageRate >= 1) return true;
    const slip = this.slippageModel.compute({
      amountSol: position.amountSol,
      solPriceUsd: this.config.solPriceUsd ?? 200,
      liquidityUsd: bar.liquidityUsd,
    });
    return slip <= this.maxExitSlippageRate;
  }

  run(bars: PriceBar[]): PositionAwareBacktestResult {
    const trades: ClosedTrade[] = [];
    const equityCurveSol: number[] = [];
    let equity = this.config.initialEquitySol;
    equityCurveSol.push(equity);
    let position: OpenPosition | null = null;
    let pendingExit: { reason: ExitReason; triggeredAtIndex: number } | null = null;

    let lastGoodIndex = -1;
    let lastGoodPriceUsd = 0;
    let lastGoodLiquidityUsd = 0;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];

      const liqGoodForLastKnown = hasKnownLiquidity(bar.liquidityUsd) && bar.liquidityUsd >= this.minExitLiquidityUsd;
      if (liqGoodForLastKnown && bar.priceUsd > 0) {
        lastGoodIndex = i;
        lastGoodPriceUsd = bar.priceUsd;
        lastGoodLiquidityUsd = bar.liquidityUsd;
      }

      if (!bar.priceUsd || bar.priceUsd <= 0) {
        equityCurveSol.push(equity);
        continue;
      }

      if (position) {
        position = this.exitRules.updateHighWatermark(position, bar.priceUsd);

        if (!pendingExit) {
          const decision = this.exitRules.evaluate(position, bar.priceUsd, bar.fetchedAt);
          if (decision.shouldExit) {
            pendingExit = { reason: decision.reason!, triggeredAtIndex: i };
          }
        }

        if (pendingExit) {
          const deferredBars = i - pendingExit.triggeredAtIndex;

          if (this.canExitOn(bar, position)) {
            equity = this.closePosition(position, bar.priceUsd, bar.liquidityUsd, i, pendingExit.reason, deferredBars, trades, equity);
            position = null;
            pendingExit = null;
            equityCurveSol.push(equity);
            continue;
          }

          if (deferredBars >= this.maxExitDeferBars) {
            const fillPrice = lastGoodPriceUsd > 0 ? lastGoodPriceUsd : position.entryPriceUsd;
            const fillLiq = lastGoodLiquidityUsd > 0 ? lastGoodLiquidityUsd : (position.entryLiquidityUsd ?? 0);
            const fillIndex = lastGoodIndex >= 0 ? lastGoodIndex : position.entryIndex;
            equity = this.closePosition(position, fillPrice, fillLiq, fillIndex, 'EXIT_FORCED_STALE', deferredBars, trades, equity);
            position = null;
            pendingExit = null;
            equityCurveSol.push(equity);
            continue;
          }

          equityCurveSol.push(equity);
          continue;
        }

        equityCurveSol.push(equity);
        continue;
      }

      // Flat: entry
      const signal = this.strategy.evaluate(bar, {
        equitySol: equity,
        riskPerTradeSol: this.config.riskPerTradeSol,
        maxPositionSol: this.config.maxPositionSol,
      });
      if (!signal) { equityCurveSol.push(equity); continue; }
      if (!hasKnownLiquidity(bar.liquidityUsd)) { equityCurveSol.push(equity); continue; }

      const notional = Math.min(signal.proposedAmountSol, equity);
      if (notional <= 0 || bar.priceUsd <= 0) { equityCurveSol.push(equity); continue; }

      position = {
        tokenMint: bar.tokenMint,
        entryIndex: i,
        entryPriceUsd: bar.priceUsd,
        entryAt: bar.fetchedAt,
        amountSol: notional,
        highWatermarkUsd: bar.priceUsd,
        entryLiquidityUsd: bar.liquidityUsd,
      };
      equityCurveSol.push(equity);
    }

    // Close any remaining position.
    if (position) {
      const lastIndex = Math.max(0, bars.length - 1);
      const lastBar = bars[lastIndex];
      const reason: ExitReason = pendingExit ? pendingExit.reason : 'END_OF_DATA';
      const deferredBars = pendingExit ? lastIndex - pendingExit.triggeredAtIndex : 0;

      let fillPrice: number;
      let fillLiq: number;
      let fillIndex: number;
      if (hasKnownLiquidity(lastBar.liquidityUsd) && lastBar.liquidityUsd >= this.minExitLiquidityUsd && lastBar.priceUsd > 0) {
        fillPrice = lastBar.priceUsd;
        fillLiq = lastBar.liquidityUsd;
        fillIndex = lastIndex;
      } else if (lastGoodPriceUsd > 0) {
        fillPrice = lastGoodPriceUsd;
        fillLiq = lastGoodLiquidityUsd;
        fillIndex = lastGoodIndex;
      } else {
        fillPrice = position.entryPriceUsd;
        fillLiq = position.entryLiquidityUsd ?? 0;
        fillIndex = position.entryIndex;
      }
      equity = this.closePosition(position, fillPrice, fillLiq, fillIndex, reason, deferredBars, trades, equity);
      position = null;
      pendingExit = null;
    }

    if (equityCurveSol[equityCurveSol.length - 1] !== equity) {
      equityCurveSol.push(equity);
    }

    const feesPaidSol = trades.reduce((s, t) => s + t.amountSol * this.config.feeRate, 0);
    const slippagePaidSol = trades.reduce((s, t) => s + t.amountSol * this.config.slippageRate, 0);

    const metrics = computeMetrics(
      trades, equityCurveSol, this.config.initialEquitySol,
      feesPaidSol, slippagePaidSol, bars.length,
    );

    const grossPnlBeforeCosts = trades.reduce(
      (s, t) =>
        s + t.pnlSol
        + t.amountSol * this.config.feeRate * 2
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
    exitPriceUsd: number,
    exitLiquidityUsd: number,
    exitBarIndex: number,
    reason: ExitReason,
    deferredBars: number,
    trades: ClosedTrade[],
    equity: number,
  ): number {
    const entry = position.entryPriceUsd;
    const grossReturn = (exitPriceUsd - entry) / entry;
    const solPriceUsd = this.config.solPriceUsd ?? 200;

    const entryLiq = position.entryLiquidityUsd;
    const entrySlipRate = hasKnownLiquidity(entryLiq)
      ? this.slippageModel.compute({ amountSol: position.amountSol, solPriceUsd, liquidityUsd: entryLiq })
      : 0;

    const exitSlipRate = hasKnownLiquidity(exitLiquidityUsd)
      ? this.slippageModel.compute({ amountSol: position.amountSol, solPriceUsd, liquidityUsd: exitLiquidityUsd })
      : 1;

    const totalCosts =
      position.amountSol * this.config.feeRate +
      position.amountSol * entrySlipRate +
      position.amountSol * this.config.feeRate +
      position.amountSol * exitSlipRate;

    const netPnl = position.amountSol * grossReturn - totalCosts;
    const returnPct = position.amountSol > 0 ? (netPnl / position.amountSol) * 100 : 0;

    trades.push({
      entryIndex: position.entryIndex,
      exitIndex: exitBarIndex,
      tokenMint: position.tokenMint,
      entryPriceUsd: entry,
      exitPriceUsd,
      amountSol: position.amountSol,
      pnlSol: netPnl,
      returnPct,
      reason,
      exitReason: reason,
      holdBars: exitBarIndex - position.entryIndex,
      deferredBars,
      entryLiquidityUsd: position.entryLiquidityUsd,
      exitLiquidityUsd,
      entrySlipRate,
      exitSlipRate,
    });

    return equity + netPnl;
  }
}
