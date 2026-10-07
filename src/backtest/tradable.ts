import { MarketSnapshot, Signal, Strategy, StrategyContext } from '../strategy/types';
import { SlippageModel } from './slippage';

export interface TradableOptions {
  /** Entries into pools with less liquidity than this are not tradeable. */
  minLiquidityUsd: number;
  /** Entries whose modelled slippage exceeds this fraction are not tradeable. */
  maxEntrySlippageRate: number;
  solPriceUsd: number;
}

/**
 * Rule 18/30: a backtest must not book trades nobody could have made.
 * Wraps a strategy and drops its entry signals when the pool is too thin
 * (or unknown) or modelled slippage is too high. The inner strategy still
 * sees every bar, so its internal state evolves exactly as before.
 */
export class TradableOnly implements Strategy {
  readonly name: string;
  readonly version: string;

  constructor(
    private readonly inner: Strategy,
    private readonly slippage: SlippageModel,
    private readonly opts: TradableOptions,
  ) {
    this.name = inner.name;
    this.version = inner.version;
  }

  evaluate(market: MarketSnapshot, ctx: StrategyContext): Signal | null {
    const signal = this.inner.evaluate(market, ctx);
    if (!signal) return null;
    if (!(market.liquidityUsd >= this.opts.minLiquidityUsd)) return null; // also rejects NaN/undefined
    const amountSol = Math.min(signal.proposedAmountSol, ctx.equitySol);
    const slip = this.slippage.compute({
      amountSol,
      solPriceUsd: this.opts.solPriceUsd,
      liquidityUsd: market.liquidityUsd,
    });
    if (!(slip <= this.opts.maxEntrySlippageRate)) return null;
    return signal;
  }
}
