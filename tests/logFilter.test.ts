import { filterPoolInitLogs } from '../src/data/poolEvents/logFilter';

describe('filterPoolInitLogs (Task 050–054 — verified patterns)', () => {
  it('returns false on empty input', () => {
    expect(filterPoolInitLogs([]).matched).toBe(false);
  });

  it('matches pump.fun BondingCurveV3 (verified)', () => {
    expect(filterPoolInitLogs(['Program log: Instruction: BondingCurveV3']).matched).toBe(true);
  });

  it('matches pump.fun BondingCurve (no version)', () => {
    expect(filterPoolInitLogs(['Program log: Instruction: BondingCurve']).matched).toBe(true);
  });

  it('matches PumpSwap InitiateTheChaos (verified)', () => {
    expect(filterPoolInitLogs(['Program log: Instruction: InitiateTheChaos']).matched).toBe(true);
  });

  it('matches Meteora InitializeLbPair (dormant)', () => {
    expect(filterPoolInitLogs(['Program log: Instruction: InitializeLbPair']).matched).toBe(true);
  });

  it('matches Orca InitializePool (dormant)', () => {
    expect(filterPoolInitLogs(['Program log: Instruction: InitializePool']).matched).toBe(true);
  });

  it('rejects swap logs', () => {
    expect(filterPoolInitLogs([
      'Program log: Instruction: SwapBaseInput',
      'Program log: Instruction: Swap',
      'Program log: Instruction: Sell',
      'Program log: Instruction: Buy',
    ]).matched).toBe(false);
  });

  it('rejects arb bot logs', () => {
    expect(filterPoolInitLogs(['Program log: Instruction: OnChainArbMultiPath']).matched).toBe(false);
  });

  it('matches if any line matches', () => {
    const logs = [
      'Program ComputeBudget invoke [1]',
      'Program log: unrelated',
      'Program log: Instruction: BondingCurveV3',
      'Program 6EF8... success',
    ];
    expect(filterPoolInitLogs(logs).matched).toBe(true);
  });
});
