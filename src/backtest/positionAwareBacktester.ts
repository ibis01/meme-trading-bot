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
 *   - One position at a time (Rule 15 max-open-positions = 1 for backtest).
 *   - Entry on signal, but only on a bar with known liquidity.
 *   - Exit only when exit rules fire, or at end of data.
 *   - Rule 30: an exit that fires on a bar with unknown liquidity is deferred
 *     to the next bar with known liquidity. If none appears within
 *     maxExitDeferBars, the trade is priced at the last known-good bar and
 *     tagged EXIT_FORCED_STALE so callers can exclude it.
 *
 * Deterministic. No I/O. Same bars + same strategy + same stops -> same result.
 */
export class PositionAwareBacktester {
  private readonly exitRules: ExitRules;
  private readonly slippageModel: SlippageModel;
  private readonly maxExitDeferBars: number;

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
  }

  run(bars: PriceBar[]): PositionAwareBacktestResult {
    const trades: ClosedTrade[] = [];
    const equityCurveSol: number[] = [];
    let equity = this.config.initialEquitySol;
    equityCurveSol.push(equity);
    let position: OpenPosition | null = null;
    let pendingExit: { reason: ExitReason; triggeredAtIndex: number } | null = null;

    // Last bar (index, price, liquidity) at which we could have transacted.
    let lastGoodIndex = -1;
    let lastGoodPriceUsd = 0;
    let lastGoodLiquidityUsd = 0;

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];

      if (hasKnownLiquidity(bar.liquidityUsd) && bar.priceUsd > 0) {
        lastGoodIndex = i;
        lastGoodPriceUsd = bar.priceUsd;
        lastGoodLiquidityUsd = bar.liquidityUsd;
      }

      if (!bar.priceUsd || bar.priceUsd <= 0) {
        equityCurveSol.push(equity);
        continue;
      }

      // --- Holding: exit rules / deferred exit ---
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

          if (hasKnownLiquidity(bar.liquidityUsd)) {
            equity = this.closePosition(
              position, bar.priceUsd, bar.liquidityUsd, i,
              pendingExit.reason, deferredBars, trades, equity,
            );
            position = null;
            pendingExit = null;
            equityCurveSol.push(equity);
            continue;
          }

          if (deferredBars >= this.maxExitDeferBars) {
            // No known liquidity in the deferral window. Rule 30: never fabricate a fill.
            const fillPrice = lastGoodPriceUsd > 0 ? lastGoodPriceUsd : position.entryPriceUsd;
            const fillLiq = lastGoodLiquidityUsd > 0 ? lastGoodLiquidityUsd : Number.POSITIVE_INFINITY;
            equity = this.closePosition(
              position, fillPrice, fillLiq, i,
              'EXIT_FORCED_STALE', deferredBars, trades, equity,
            );
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

      // --- Flat: evaluate entry ---
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

    // --- Close any remaining position ---
    if (position) {
      const lastIndex = Math.max(0, bars.length - 1);
      const lastBar = bars[lastIndex];
      const reason: ExitReason = pendingExit ? pendingExit.reason : 'END_OF_DATA';
      const deferredBars = pendingExit ? lastIndex - pendingExit.triggeredAtIndex : 0;

      let fillPrice: number;
      let fillLiq: number;
      let fillIndex: number;
      if (hasKnownLiquidity(lastBar.liquidityUsd) && lastBar.priceUsd > 0) {
        fillPrice = lastBar.priceUsd;
        fillLiq = lastBar.liquidityUsd;
        fillIndex = lastIndex;
      } else if (lastGoodPriceUsd > 0) {
        fillPrice = lastGoodPriceUsd;
        fillLiq = lastGoodLiquidityUsd > 0 ? lastGoodLiquidityUsd : Number.POSITIVE_INFINITY;
        fillIndex = lastGoodIndex;
      } else {
        fillPrice = position.entryPriceUsd;
        fillLiq = position.entryLiquidityUsd ?? Number.POSITIVE_INFINITY;
        fillIndex = position.entryIndex;
      }
      equity = this.closePosition(position, fillPrice, fillLiq, fillIndex, reason, deferredBars, trades, equity);
      position = null;
      pendingExit = null;
    }

    if (equityCurveSol[equityCurveSol.length - 1] !== equity) {
      equityCurveSol.push(equity);
    }

    // Match previous metric-accounting formula (one-sided per trade).
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

    // Entry-side costs use the entry bar's known liquidity.
    const entryLiq = position.entryLiquidityUsd;
    const entrySlipRate = hasKnownLiquidity(entryLiq)
      ? this.slippageModel.compute({ amountSol: position.amountSol, solPriceUsd, liquidityUsd: entryLiq })
      : 0;

    // Exit-side costs. exitLiquidityUsd is always known-or-+Infinity.
    // PoolAwareSlippageModel must never see <= 0 here.
    const exitSlipRate = Number.isFinite(exitLiquidityUsd)
      ? this.slippageModel.compute({ amountSol: position.amountSol, solPriceUsd, liquidityUsd: exitLiquidityUsd })
      : 0;

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
    });

    return equity + netPnl;
  }
}
