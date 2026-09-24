import { StrategyGate } from '../src/risk/strategyGate';
import { InMemoryStrategyVerdictStore } from '../src/state/strategyVerdicts';

describe('StrategyGate (Rule 17)', () => {
  it('allows anything when disabled (paper mode)', async () => {
    const gate = new StrategyGate(new InMemoryStrategyVerdictStore(), false);
    expect(await gate.check('anything', '1.0.0')).toBeNull();
  });

  it('blocks unapproved strategies when enabled', async () => {
    const gate = new StrategyGate(new InMemoryStrategyVerdictStore(), true);
    const reason = await gate.check('MEME_MOMENTUM_V1', '1.0.0');
    expect(reason).toBe('STRATEGY_NOT_APPROVED:MEME_MOMENTUM_V1@1.0.0');
  });

  it('allows approved strategies when enabled', async () => {
    const store = new InMemoryStrategyVerdictStore();
    await store.upsert({
      strategyName: 'MEME_MOMENTUM_V1',
      strategyVersion: '1.0.0',
      flags: ['EDGE_CONFIRMED'],
      approved: true,
      trainReturnPct: 1,
      validationReturnPct: 1,
      testReturnPct: 1,
      createdAt: Date.now(),
    });
    const gate = new StrategyGate(store, true);
    expect(await gate.check('MEME_MOMENTUM_V1', '1.0.0')).toBeNull();
  });

  it('treats version mismatches as unapproved', async () => {
    const store = new InMemoryStrategyVerdictStore();
    await store.upsert({
      strategyName: 'MEME_MOMENTUM_V1',
      strategyVersion: '1.0.0',
      flags: ['EDGE_CONFIRMED'],
      approved: true,
      trainReturnPct: 0, validationReturnPct: 0, testReturnPct: 0,
      createdAt: Date.now(),
    });
    const gate = new StrategyGate(store, true);
    expect(await gate.check('MEME_MOMENTUM_V1', '2.0.0')).not.toBeNull();
  });
});
