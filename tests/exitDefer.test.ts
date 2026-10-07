import { PositionAwareBacktester } from '../src/backtest/positionAwareBacktester';
import { AlwaysBuyStrategy } from '../src/strategy/baselines';
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

function cfg(maxExitDeferBars?: number): PositionAwareBacktestConfig {
  return {
    feeRate: 0,
    slippageRate: 0,
    initialEquitySol: 10,
    riskPerTradeSol: 1,
    maxPositionSol: 1,
    split: 'test',
    solPriceUsd: 200,
    stops: { hardStopPct: 0.2 },
    maxExitDeferBars,
  };
}

describe('PositionAwareBacktester exit deferral (Rule 30)', () => {
  it('fills on the trigger bar when liquidity is known (no regression)', () => {
    const bars = [bar(0, 100, 10_000), bar(1, 70, 10_000)];
    const res = new PositionAwareBacktester(new AlwaysBuyStrategy(), cfg()).run(bars);
    const t = res.trades[0] as ClosedTrade;
    expect(t.exitReason).toBe('HARD_STOP');
    expect(t.exitIndex).toBe(1);
    expect(t.deferredBars).toBe(0);
  });

  it('defers a hard-stop fill past a zero-liquidity bar', () => {
    const bars = [
      bar(0, 100, 10_000),
      bar(1, 100, 10_000),
      bar(2, 70, 0),
      bar(3, 68, 10_000),
    ];
    const res = new PositionAwareBacktester(new AlwaysBuyStrategy(), cfg()).run(bars);
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0] as ClosedTrade;
    expect(t.exitReason).toBe('HARD_STOP');
    expect(t.exitIndex).toBe(3);
    expect(t.exitPriceUsd).toBe(68);
    expect(t.deferredBars).toBe(1);
  });

  it('tags EXIT_FORCED_STALE when no liquid bar appears within maxExitDeferBars', () => {
    const bars = [
      bar(0, 100, 10_000),
      bar(1, 100, 10_000),
      bar(2, 70, 0),
      bar(3, 60, 0),
      bar(4, 50, 0),
      bar(5, 40, 0),
      bar(6, 30, 0),
    ];
    const res = new PositionAwareBacktester(new AlwaysBuyStrategy(), cfg(3)).run(bars);
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0] as ClosedTrade;
    expect(t.exitReason).toBe('EXIT_FORCED_STALE');
    // Priced at the last known-good bar (index 1 = 100), not at a phantom -200%.
    expect(t.exitPriceUsd).toBe(100);
    expect(t.returnPct).toBe(0);
  });

  it('never books a positive price move as a total loss (FG7D5D regression)', () => {
    const bars = [
      bar(0, 100, 10_000),
      bar(1, 105, 0),
      bar(2, 110, 10_000),
    ];
    const res = new PositionAwareBacktester(new AlwaysBuyStrategy(), cfg()).run(bars);
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0] as ClosedTrade;
    expect(t.returnPct).toBeGreaterThan(0);
    expect(t.exitPriceUsd).toBe(110);
  });

  it('does not open a position on a bar with unknown liquidity', () => {
    const bars = [
      bar(0, 100, 0),
      bar(1, 100, 10_000),
      bar(2, 100, 10_000),
    ];
    const res = new PositionAwareBacktester(new AlwaysBuyStrategy(), cfg()).run(bars);
    expect(res.trades).toHaveLength(1);
    expect(res.trades[0].entryIndex).toBe(1);
  });
});
