import { computeRealizedPnlSol } from '../src/execution/realizedPnl';

describe('computeRealizedPnlSol (Rule 7)', () => {
  it('BUY has zero realized PnL', () => {
    expect(computeRealizedPnlSol({ side: 'BUY', filledAmountSol: 0.5 })).toBe(0);
  });

  it('SELL with cost basis computes proceeds - basis', () => {
    expect(computeRealizedPnlSol({
      side: 'SELL', filledAmountSol: 0.6, costBasisSol: 0.5,
    })).toBeCloseTo(0.1, 8);
  });

  it('SELL losing trade produces negative PnL', () => {
    expect(computeRealizedPnlSol({
      side: 'SELL', filledAmountSol: 0.4, costBasisSol: 0.5,
    })).toBeCloseTo(-0.1, 8);
  });

  it('SELL without cost basis throws (Rule 30: no guessing)', () => {
    expect(() => computeRealizedPnlSol({ side: 'SELL', filledAmountSol: 0.5 }))
      .toThrow('MISSING_COST_BASIS_FOR_SELL');
  });
});
