import { PositionAwareBacktester } from '../src/backtest/positionAwareBacktester';
import { AlwaysBuyStrategy } from '../src/strategy/baselines';
import { SlippageModel } from '../src/backtest/slippage';
import { PriceBar, PositionAwareBacktestConfig, ClosedTrade } from '../src/backtest/types';

const T0 = Date.UTC(2025, 0, 1);

function bar(i: number, priceUsd: number, liquidityUsd: number): PriceBar {
  return {
    tokenMint: 'TEST',
    priceUsd,
    nextPriceUsd: priceUsd,
    liquidityUsd,
    fetchedAt: T0 + i * 60_000,
  } as unknown as PriceBar;
}

class ZeroSlippage implements SlippageModel {
  compute(): number { return 0; }
}

function cfg(o: Partial<PositionAwareBacktestConfig> = {}): PositionAwareBacktestConfig {
  return {
    feeRate: 0,
    slippageRate: 0,
    initialEquitySol: 10,
    riskPerTradeSol: 1,
    maxPositionSol: 1,
    split: 'test',
    solPriceUsd: 200,
    stops: { hardStopPct: 0.2 },
    ...o,
  };
}

describe('PositionAwareBacktester exit deferral (Rule 30)', () => {
  it('fills on the trigger bar when liquidity is known', () => {
    const bars = [bar(0, 100, 10_000), bar(1, 70, 10_000)];
    const res = new PositionAwareBacktester(new AlwaysBuyStrategy(), cfg()).run(bars);
    const t = res.trades[0] as ClosedTrade;
    expect(t.exitReason).toBe('HARD_STOP');
    expect(t.exitIndex).toBe(1);
    expect(t.deferredBars).toBe(0);
  });

  it('defers a hard-stop fill past a zero-liquidity bar', () => {
    const bars = [bar(0, 100, 10_000), bar(1, 100, 10_000), bar(2, 70, 0), bar(3, 68, 10_000)];
    const res = new PositionAwareBacktester(new AlwaysBuyStrategy(), cfg()).run(bars);
    const t = res.trades[0] as ClosedTrade;
    expect(t.exitReason).toBe('HARD_STOP');
    expect(t.exitIndex).toBe(3);
    expect(t.exitPriceUsd).toBe(68);
    expect(t.deferredBars).toBe(1);
  });

  it('defers past a thin-liquidity bar below minExitLiquidityUsd (thin-exit regression)', () => {
    // Entry on $10k bar. Hard stop fires on a $100 bar (positive but under the gate).
    // Next bar is $10k. Must defer, not book a phantom -100%.
    const bars = [bar(0, 100, 10_000), bar(1, 100, 10_000), bar(2, 70, 100), bar(3, 68, 10_000)];
    const res = new PositionAwareBacktester(
      new AlwaysBuyStrategy(),
      cfg({ minExitLiquidityUsd: 5000, maxExitSlippageRate: 0.1 }),
      new ZeroSlippage(),
    ).run(bars);
    const t = res.trades[0] as ClosedTrade;
    expect(t.exitReason).toBe('HARD_STOP');
    expect(t.exitIndex).toBe(3);
    expect(t.exitPriceUsd).toBe(68);
    expect(t.deferredBars).toBe(1);
    expect(t.returnPct).toBeCloseTo((68 - 100) / 100 * 100, 6);
  });

  it('defers past a high-slippage bar when maxExitSlippageRate is set', () => {
    // $2000 liq with notional large enough that pool-aware slippage > 10% on exits.
    const bars = [bar(0, 100, 100_000), bar(1, 100, 100_000), bar(2, 70, 3000), bar(3, 68, 100_000)];
    // A slippage model that returns 50% when liquidity < 5000 and 0 otherwise.
    const slip: SlippageModel = {
      compute: (c) => (c.liquidityUsd < 5000 ? 0.5 : 0),
    };
    const res = new PositionAwareBacktester(
      new AlwaysBuyStrategy(),
      cfg({ minExitLiquidityUsd: 0, maxExitSlippageRate: 0.1 }),
      slip,
    ).run(bars);
    const t = res.trades[0] as ClosedTrade;
    expect(t.exitIndex).toBe(3);
    expect(t.deferredBars).toBe(1);
  });

  it('tags EXIT_FORCED_STALE when no usable bar appears within maxExitDeferBars', () => {
    const bars = [
      bar(0, 100, 10_000),
      bar(1, 100, 10_000),
      bar(2, 70, 100),
      bar(3, 60, 100),
      bar(4, 50, 100),
      bar(5, 40, 100),
    ];
    const res = new PositionAwareBacktester(
      new AlwaysBuyStrategy(),
      cfg({ maxExitDeferBars: 2, minExitLiquidityUsd: 5000 }),
      new ZeroSlippage(),
    ).run(bars);
    const t = res.trades[0] as ClosedTrade;
    expect(t.exitReason).toBe('EXIT_FORCED_STALE');
    expect(t.exitPriceUsd).toBe(100); // last known-good bar (index 1)
    expect(t.returnPct).toBeCloseTo(0, 6);
  });

  it('never books a positive price move as a total loss (FG7D5D/ZAqgRC regression)', () => {
    const bars = [bar(0, 100, 10_000), bar(1, 105, 100), bar(2, 110, 10_000)];
    const res = new PositionAwareBacktester(
      new AlwaysBuyStrategy(),
      cfg({ minExitLiquidityUsd: 5000, maxExitSlippageRate: 0.1 }),
      new ZeroSlippage(),
    ).run(bars);
    const t = res.trades[0] as ClosedTrade;
    expect(t.returnPct).toBeGreaterThan(0);
    expect(t.exitPriceUsd).toBe(110);
  });

  it('does not open a position on a bar with unknown liquidity', () => {
    const bars = [bar(0, 100, 0), bar(1, 100, 10_000), bar(2, 100, 10_000)];
    const res = new PositionAwareBacktester(new AlwaysBuyStrategy(), cfg()).run(bars);
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].entryIndex).toBe(1);
  });
});
