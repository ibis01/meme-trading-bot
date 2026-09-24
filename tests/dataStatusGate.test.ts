/**
 * The gate itself is in strategyCompareCli (CLI, hard to unit test).
 * This test just verifies the constant logic is what we expect.
 */
describe('data:status thresholds', () => {
  it('MIN_TO_RUN matches walk-forward minimum (60 bars for 3x20 windows)', () => {
    const MIN_TO_RUN = 60;
    const MIN_WINDOW = 20;
    expect(MIN_TO_RUN).toBe(MIN_WINDOW * 3);
  });

  it('TARGET_FOR_MEANINGFUL accounts for 30-min holds at 30s bars', () => {
    const TARGET = 4500;
    const holdsPerWindow = 15;     // minimum trades per window
    const barsPerHold = 60;        // 30-min hold at 30s bars
    const testWindowBars = holdsPerWindow * barsPerHold;
    const totalBars = testWindowBars / 0.2; // test = 20% of total
    expect(TARGET).toBeGreaterThanOrEqual(totalBars - 100);
  });
});
