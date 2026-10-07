import { dropRevertingSpikes } from '../src/backtest/sanitize';
import { PriceBar } from '../src/backtest/types';

const STEP = 30_000;
const bar = (i: number, price: number): PriceBar => ({
  tokenMint: 'm', fetchedAt: 1_700_000_000_000 + i * STEP, priceUsd: price, nextPriceUsd: 0,
  liquidityUsd: 1, volume24hUsd: 1, priceChange5mPercent: 0, priceChange1hPercent: 0,
});
const flat = (n: number, price: number, from = 0) => Array.from({ length: n }, (_, k) => bar(from + k, price));

describe('dropRevertingSpikes', () => {
  it('leaves a clean series untouched', () => {
    const bars = flat(20, 1);
    const r = dropRevertingSpikes(bars);
    expect(r.dropped).toBe(0);
    expect(r.bars).toHaveLength(20);
  });

  it('drops a single-bar glitch that reverts (0.0000038 -> 0.06 -> 0.0000038)', () => {
    const bars = [...flat(10, 0.0000038), bar(10, 0.06), ...flat(10, 0.0000038, 11)];
    const r = dropRevertingSpikes(bars);
    expect(r.dropped).toBe(1);
    expect(r.bars.every((b) => b.priceUsd < 0.001)).toBe(true);
  });

  it('drops a multi-bar glitch that reverts within the time limit', () => {
    const bars = [...flat(10, 1), ...flat(8, 5000, 10), ...flat(10, 1, 18)];
    const r = dropRevertingSpikes(bars);
    expect(r.dropped).toBe(8);
    expect(r.bars.every((b) => b.priceUsd === 1)).toBe(true);
  });

  it('keeps a permanent level change (no revert) — genuine regime shift', () => {
    const bars = [...flat(10, 1), ...flat(20, 5000, 10)];
    const r = dropRevertingSpikes(bars);
    expect(r.dropped).toBe(0);
    expect(r.bars).toHaveLength(30);
  });

  it('keeps a glitch-looking run that does not revert within maxRunMs', () => {
    const bars = [...flat(10, 1), ...flat(80, 5000, 10), ...flat(10, 1, 90)]; // 40 min run
    const r = dropRevertingSpikes(bars);
    expect(r.dropped).toBe(0);
  });

  it('keeps a continuous real pump and dump (each step within 50x)', () => {
    const prices = [1, 2, 4, 8, 16, 32, 64, 128, 64, 32, 16, 8, 4, 2, 1];
    const r = dropRevertingSpikes(prices.map((p, i) => bar(i, p)));
    expect(r.dropped).toBe(0);
  });

  it('drops a bad first bar by baselining on the median of early bars', () => {
    const bars = [bar(0, 0.06), ...flat(10, 0.0000038, 1)];
    const r = dropRevertingSpikes(bars);
    expect(r.dropped).toBe(1);
    expect(r.bars[0].priceUsd).toBe(0.0000038);
  });

  it('does not mutate its input', () => {
    const bars = [...flat(5, 1), bar(5, 1000), ...flat(5, 1, 6)];
    const copy = JSON.stringify(bars);
    dropRevertingSpikes(bars);
    expect(JSON.stringify(bars)).toBe(copy);
  });
});
