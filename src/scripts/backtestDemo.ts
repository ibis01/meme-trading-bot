import { Backtester } from '../backtest/engine';
import { MomentumStrategy, syntheticMomentumConfig } from '../strategy/momentum';
import { PriceBar } from '../backtest/types';

function makeBars(prices: number[]): PriceBar[] {
  return prices.slice(0, -1).map((priceUsd, i) => ({
    tokenMint: 'DEMO_MINT',
    fetchedAt: 1_700_000_000_000 + i * 60_000,
    priceUsd,
    nextPriceUsd: prices[i + 1],
    liquidityUsd: 250_000,
    volume24hUsd: 1_000_000,
    holderCount: 3_200,
    top10HolderPercent: 22,
    smartWalletNetFlowUsd: 8_500,
    priceChange5mPercent: 6.4,
    priceChange1hPercent: 14.1,
  }));
}

const prices = Array.from({ length: 60 }, (_, i) => 1 + Math.sin(i / 8) * 0.05 + i * 0.002);
const bars = makeBars(prices);
const bt = new Backtester(new MomentumStrategy(syntheticMomentumConfig), {
  feeRate: 0.002,
  slippageRate: 0.003,
  initialEquitySol: 10,
  riskPerTradeSol: 0.1,
  maxPositionSol: 0.1,
  split: 'train',
});

const r = bt.run(bars);
console.log(JSON.stringify({
  metrics: r.metrics,
  trades: r.trades.length,
  profitableAfterCosts: r.profitableAfterCosts,
}, null, 2));
