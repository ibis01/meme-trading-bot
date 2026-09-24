export interface SlippageContext {
  /** Trade notional in SOL. */
  amountSol: number;
  /** SOL/USD price at trade time. */
  solPriceUsd: number;
  /** Pool liquidity in USD at trade time. */
  liquidityUsd: number;
}

export interface SlippageModel {
  /** Returns slippage as a decimal fraction (0.003 = 30 bps). */
  compute(ctx: SlippageContext): number;
}

/** Legacy behavior: constant slippage regardless of size or liquidity. */
export class ConstantSlippageModel implements SlippageModel {
  constructor(private readonly rate: number) {}
  compute(_ctx: SlippageContext): number {
    return this.rate;
  }
}

/**
 * Rule 18: pool-aware slippage.
 *
 *   slippage = baseSpread + impactFactor × (tradeSizeUsd / liquidityUsd)
 *
 * Rationale (constant-product AMM, both sides counted):
 *   price_impact ≈ amount_in / reserve ≈ 2 × tradeSizeUsd / liquidityUsd
 * We add a base spread for memecoin DEX fees and thin order books.
 *
 * Defaults: 50 bps base (typical memecoin effective spread),
 *           impactFactor 2 (constant-product assumption).
 *
 * If liquidityUsd <= 0, returns 1.0 (100% slippage) → trade effectively rejected.
 */
export class PoolAwareSlippageModel implements SlippageModel {
  constructor(
    private readonly baseSpreadBps: number = 50,
    private readonly impactFactor: number = 2,
  ) {
    if (baseSpreadBps < 0) throw new Error('baseSpreadBps must be >= 0');
    if (impactFactor <= 0) throw new Error('impactFactor must be > 0');
  }

  compute(ctx: SlippageContext): number {
    if (ctx.liquidityUsd <= 0) return 1;
    const tradeSizeUsd = ctx.amountSol * ctx.solPriceUsd;
    const impact = (this.impactFactor * tradeSizeUsd) / ctx.liquidityUsd;
    const base = this.baseSpreadBps / 10_000;
    return base + impact;
  }
}
