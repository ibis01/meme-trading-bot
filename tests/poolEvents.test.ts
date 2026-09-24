import { MockPoolEventSource } from '../src/data/poolEvents/mock';
import { DEX_PROGRAMS, ALL_PROGRAM_IDS } from '../src/data/poolEvents/dexPrograms';
import { PoolEvent } from '../src/data/poolEvents/types';

const fixture = (o: Partial<PoolEvent> = {}): PoolEvent => ({
  kind: 'POOL_CREATED',
  dex: 'raydium',
  poolAddress: 'pool1',
  baseMint: 'mint1',
  quoteMint: 'So11111111111111111111111111111111111111112',
  creatorWallet: 'creator1',
  signature: 'sig1',
  slot: 1,
  blockTimeMs: Date.now(),
  ...o,
});

describe('PoolEventSource (Task 044)', () => {
  it('mock source emits fixtures on start and stops cleanly', async () => {
    const events: PoolEvent[] = [];
    const src = new MockPoolEventSource({
      fixtures: [fixture({ signature: 'a' }), fixture({ signature: 'b' }), fixture({ signature: 'c' })],
      intervalMs: 10,
    });
    src.onEvent((e) => { events.push(e); });
    await src.start();
    expect(src.isRunning()).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(events.map((e) => e.signature)).toEqual(['a', 'b', 'c']);
    await src.stop();
    expect(src.isRunning()).toBe(false);
  });

  it('unsubscribe stops delivery', async () => {
    const events: PoolEvent[] = [];
    const src = new MockPoolEventSource({
      fixtures: [fixture({ signature: 'a' }), fixture({ signature: 'b' })],
      intervalMs: 20,
    });
    const off = src.onEvent((e) => { events.push(e); });
    await src.start();
    await new Promise((r) => setTimeout(r, 30));
    off();
    await new Promise((r) => setTimeout(r, 40));
    // Only the first event should have been delivered before unsubscribe.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(1);
    await src.stop();
  });

  it('handler errors do not crash the source', async () => {
    const src = new MockPoolEventSource({
      fixtures: [fixture({ signature: 'a' }), fixture({ signature: 'b' })],
      intervalMs: 10,
    });
    let called = 0;
    src.onEvent(() => { called += 1; throw new Error('boom'); });
    await src.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBeGreaterThan(0);
    await src.stop();
  });

  it('start is idempotent', async () => {
    const src = new MockPoolEventSource({ fixtures: [], intervalMs: 10 });
    await src.start();
    await src.start();
    expect(src.isRunning()).toBe(true);
    await src.stop();
  });

  it('DEX program registry is complete and non-empty', () => {
    expect(ALL_PROGRAM_IDS.length).toBeGreaterThan(0);
    expect(Object.values(DEX_PROGRAMS)).toEqual(
      expect.arrayContaining(['raydium', 'meteora', 'orca']),
    );
  });
});
