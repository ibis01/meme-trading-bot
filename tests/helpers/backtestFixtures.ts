import { PriceBar } from '../../src/backtest/types';

/**
 * Build a synthetic bar series. `prices` is the price path; each bar's
 * `nextPriceUsd` is the following price so the backtester has a real exit.
 */
export function makeBars(
  prices: number[],
  opts: { tokenMint?: string; momentum?: boolean } = {},
): PriceBar[] {
  const tokenMint = opts.tokenMint ?? 'mint';
  const bars: PriceBar[] = [];
  for (let i = 0; i < prices.length - 1; i++) {
    const priceUsd = prices[i];
    const nextPriceUsd = prices[i + 1];
    bars.push({
      tokenMint,
      fetchedAt: 1_700_000_000_000 + i * 60_000,
      priceUsd,
      nextPriceUsd,
      liquidityUsd: 250_000,
      volume24hUsd: 1_000_000,
      holderCount: 3_200,
      top10HolderPercent: 22,
      smartWalletNetFlowUsd: opts.momentum === false ? -100 : 8_500,
      priceChange5mPercent: opts.momentum === false ? 0.1 : 6.4,
      priceChange1hPercent: opts.momentum === false ? 0.2 : 14.1,
    });
  }
  return bars;
}
