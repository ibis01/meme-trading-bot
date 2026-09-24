import { selectStops, syntheticStops, realDataStops } from '../src/backtest/stopPresets';

describe('Stop presets (Rule 16)', () => {
  it('real preset has tighter stops than synthetic', () => {
    expect(realDataStops.hardStopPct).toBeLessThan(syntheticStops.hardStopPct);
    expect(realDataStops.trailingStopPct).toBeLessThan(syntheticStops.trailingStopPct!);
    expect(realDataStops.timeStopMs!).toBeLessThan(syntheticStops.timeStopMs!);
  });

  it('selectStops defaults to real', () => {
    expect(selectStops(undefined)).toEqual(realDataStops);
  });

  it('selectStops handles explicit modes', () => {
    expect(selectStops('real')).toEqual(realDataStops);
    expect(selectStops('synthetic')).toEqual(syntheticStops);
  });

  it('selectStops rejects unknown modes', () => {
    expect(() => selectStops('bogus')).toThrow();
  });

  it('real preset time stop = 5 min, hard stop = 3%, trailing = 2%', () => {
    expect(realDataStops.hardStopPct).toBe(0.03);
    expect(realDataStops.trailingStopPct).toBe(0.02);
    expect(realDataStops.timeStopMs).toBe(5 * 60 * 1000);
  });
});
