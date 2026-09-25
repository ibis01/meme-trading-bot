import { PositionAwareBacktester } from '../src/backtest/positionAwareBacktester';
import { AlwaysBuyStrategy } from '../src/strategy/baselines';
import { PriceBar } from '../src/backtest/types';

/**
 * Rule 18: exit fill is the price on the bar where the stop triggered.
 * Regression test for the future-data leak in closePosition().
 */
function bar(priceUsd: number, i: number): PriceBar {
  return {
    tokenMint: 'mint',
    fetchedAt: 1_700_000_000_000 + i * 60_000,
    priceUsd,
    nextPriceUsd: 0, // will be overwritten below
    liquidityUsd: 1_000_000,
    volume24hUsd: 1_000_000,
    holderCount: 1_000,
    top10HolderPercent: 20,
    priceChange5mPercent: 6,
    priceChange1hPercent: 10,
  };
}

function link(prices: number[]): PriceBar[] {
  return prices.map((p, i) => {
    const b = bar(p, i);
    b.nextPriceUsd = i < prices.length - 1 ? prices[i + 1] : 0;
    return b;
  });
}

describe('PositionAwareBacktester — exit timing (Rule 18)', () => {
  const config = {
    feeRate: 0,
    slippageRate: 0,
    initialEquitySol: 10,
    riskPerTradeSol: 0.1,
    maxPositionSol: 0.1,
    split: 'train' as const,
    stops: { hardStopPct: 0.15 },
  };

  it('fills a hard stop at the TRIGGERING bar price, not the next bar', () => {
    // Entry at 1.00, then a drop to 0.70 (below the 15% stop floor of 0.85),
    // then a bounce to 0.95 on the next bar. Old (buggy) code would exit at
    // 0.95. Fixed code must exit at 0.70.
    const bars = link([1.00, 1.00, 1.00, 0.70, 0.95, 1.10]);
    const bt = new PositionAwareBacktester(new AlwaysBuyStrategy(0.1), config);
    const r = bt.run(bars);
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    const t = r.trades[0];
    expect(t.exitReason).toBe('HARD_STOP');
    expect(t.exitPriceUsd).toBeCloseTo(0.70, 6);
    // No costs, so PnL is purely price: (0.70 - 1.00) / 1.00 = -30% of notional.
    expect(t.pnlSol).toBeCloseTo(-0.30 * t.amountSol, 6);
  });

  it('does not benefit from a bounce on the bar after the stop', () => {
    // Two price paths: same stop trigger, different post-trigger bounce.
    // With the fix, PnL must be identical on both (exit at trigger bar).
    const pathA = link([1.00, 1.00, 1.00, 0.70, 0.95, 0.80]);
    const pathB = link([1.00, 1.00, 1.00, 0.70, 0.20, 0.80]);

    const btA = new PositionAwareBacktester(new AlwaysBuyStrategy(0.1), config);
    const btB = new PositionAwareBacktester(new AlwaysBuyStrategy(0.1), config);
    const rA = btA.run(pathA);
    const rB = btB.run(pathB);

    expect(rA.trades[0].exitPriceUsd).toBeCloseTo(rB.trades[0].exitPriceUsd, 6);
    expect(rA.trades[0].pnlSol).toBeCloseTo(rB.trades[0].pnlSol, 6);
  });

  it('still exits at the current bar for trailing stops', () => {
    // Trail stop 5%. Entry at 1.00, price rises to 2.00 (HWM), falls to 1.80
    // (above 1.90 trail floor) — no exit. Falls to 1.80 more — triggers.
    const bars = link([1.00, 1.50, 2.00, 1.80, 1.60, 1.20]);
    const bt = new PositionAwareBacktester(new AlwaysBuyStrategy(0.1), {
      ...config,
      stops: { hardStopPct: 0.5, trailingStopPct: 0.05 },
    });
    const r = bt.run(bars);
    expect(r.trades.length).toBeGreaterThanOrEqual(1);
    expect(r.trades[0].exitReason).toBe('TRAILING_STOP');
  });
});
