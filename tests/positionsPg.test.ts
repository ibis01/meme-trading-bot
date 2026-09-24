import { PostgresPositionStore } from '../src/state/positionsPg';

interface Row { open_positions: number }

function mockPool(initial: number) {
  let current = initial;
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT')) {
        return { rows: [{ open_positions: current }] as Row[] };
      }
      if (sql.includes('open_positions + 1')) {
        current += 1;
        return { rows: [{ open_positions: current }] as Row[] };
      }
      if (sql.includes('GREATEST')) {
        current = Math.max(0, current - 1);
        return { rows: [{ open_positions: current }] as Row[] };
      }
      return { rows: [] };
    }),
  } as unknown as { query: jest.Mock };
}

describe('PostgresPositionStore (Rule 21)', () => {
  it('reads the current count', async () => {
    const store = new PostgresPositionStore(mockPool(3) as never);
    expect(await store.getOpenCount()).toBe(3);
  });

  it('increments atomically', async () => {
    const store = new PostgresPositionStore(mockPool(0) as never);
    expect(await store.increment()).toBe(1);
    expect(await store.increment()).toBe(2);
    expect(await store.getOpenCount()).toBe(2);
  });

  it('never decrements below zero', async () => {
    const store = new PostgresPositionStore(mockPool(0) as never);
    expect(await store.decrement()).toBe(0);
    expect(await store.getOpenCount()).toBe(0);
  });

  it('handles missing portfolio_state row gracefully', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [] })) };
    const store = new PostgresPositionStore(pool as never);
    expect(await store.getOpenCount()).toBe(0);
  });
});
