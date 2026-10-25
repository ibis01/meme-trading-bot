import { resolveStrategyGateEnabled } from '../src/risk/gatePolicy';

/**
 * Locks the strategy-gate enablement contract that the Phase 1 commit batch
 * inverted (the soak-killer regression fixed in 8e1f295): a disabled gate
 * means "no strategy-level gating", NEVER "reject everything".
 */
describe('resolveStrategyGateEnabled (Rule 17 bootstrap policy)', () => {
  it('always enables the gate in live mode', () => {
    expect(resolveStrategyGateEnabled('live', undefined)).toBe(true);
    expect(resolveStrategyGateEnabled('live', '')).toBe(true);
    expect(resolveStrategyGateEnabled('live', 'false')).toBe(true);
  });

  it('disables the gate in paper mode by default (soak keeps trading)', () => {
    expect(resolveStrategyGateEnabled('paper', undefined)).toBe(false);
    expect(resolveStrategyGateEnabled('paper', '')).toBe(false);
    expect(resolveStrategyGateEnabled('paper', 'false')).toBe(false);
  });

  it('opts paper mode in only via strict lowercase "true"', () => {
    expect(resolveStrategyGateEnabled('paper', 'true')).toBe(true);
    expect(resolveStrategyGateEnabled('paper', 'TRUE')).toBe(false);
    expect(resolveStrategyGateEnabled('paper', '1')).toBe(false);
    expect(resolveStrategyGateEnabled('paper', ' yes ')).toBe(false);
  });

  it('treats manual mode like paper (off unless opted in)', () => {
    expect(resolveStrategyGateEnabled('manual', undefined)).toBe(false);
    expect(resolveStrategyGateEnabled('manual', 'true')).toBe(true);
  });
});
