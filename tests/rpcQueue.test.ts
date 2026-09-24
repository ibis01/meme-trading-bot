import { RpcQueue } from '../src/data/poolEvents/rpcQueue';

describe('RpcQueue (Task 055 — serialized)', () => {
  it('runs jobs with bounded concurrency', async () => {
    const q = new RpcQueue<number>({ concurrency: 1, minSpacingMs: 0 });
    let maxConcurrent = 0;
    let active = 0;
    const jobs = Array.from({ length: 5 }, (_, i) =>
      q.enqueue(async () => {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return i;
      }),
    );
    const results = await Promise.all(jobs);
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(maxConcurrent).toBe(1);
  });

  it('spaces job starts by minSpacingMs', async () => {
    const q = new RpcQueue<number>({ concurrency: 1, minSpacingMs: 50 });
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all([0, 1, 2].map((i) => q.enqueue(async () => { starts.push(Date.now() - t0); return i; })));
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(40);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(40);
  });

  it('propagates errors without blocking the queue', async () => {
    const q = new RpcQueue<number>({ concurrency: 1, minSpacingMs: 0 });
    const a = q.enqueue(async () => { throw new Error('boom'); }).catch((e) => `caught:${e.message}`);
    const b = q.enqueue(async () => 42);
    expect(await a).toBe('caught:boom');
    expect(await b).toBe(42);
  });

  it('resolves null when queue exceeds maxQueueLength (backpressure)', async () => {
    const q = new RpcQueue<number>({ concurrency: 1, minSpacingMs: 100, maxQueueLength: 2 });
    const pending = [
      q.enqueue(async () => { await new Promise((r) => setTimeout(r, 300)); return 1; }),
      q.enqueue(async () => 2),
      q.enqueue(async () => 3),
    ];
    const overflow = await q.enqueue(async () => 4);
    expect(overflow).toBeNull();
    await Promise.all(pending);
  });

  it('reports queue size', async () => {
    const q = new RpcQueue<number>({ concurrency: 1, minSpacingMs: 100, maxQueueLength: 100 });
    void q.enqueue(async () => 1);
    void q.enqueue(async () => 2);
    expect(q.size()).toBeGreaterThanOrEqual(1);
  });
});
