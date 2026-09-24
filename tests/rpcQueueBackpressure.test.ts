import { RpcQueue } from '../src/data/poolEvents/rpcQueue';

describe('RpcQueue — silent drop on full (Task 056)', () => {
  it('resolves null instead of rejecting when queue is full', async () => {
    const q = new RpcQueue<number>({ concurrency: 1, minSpacingMs: 100, maxQueueLength: 1 });
    // First job will run for 300ms
    const j1 = q.enqueue(async () => { await new Promise((r) => setTimeout(r, 300)); return 1; });
    // Second goes into queue
    const j2 = q.enqueue(async () => 2);
    // Third overflows — should resolve null, not reject
    const j3 = q.enqueue(async () => 3);
    expect(await j3).toBeNull();
    await Promise.all([j1, j2]);
  });
});
