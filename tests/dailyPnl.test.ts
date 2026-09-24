import { InMemoryPnlStore } from '../src/state/dailyPnl';

describe('DailyPnlStore', () => {
  it('starts at 0', async () => {
    const store = new InMemoryPnlStore();
    expect(await store.getToday()).toBe(0);
  });

  it('accumulates gains and losses', async () => {
    const store = new InMemoryPnlStore();
    await store.addSol(-0.1);
    await store.addSol(-0.2);
    await store.addSol(0.05);
    expect(await store.getToday()).toBeCloseTo(-0.25, 8);
  });
});
