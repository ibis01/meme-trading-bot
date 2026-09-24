import { IdempotencyService, RedisLike } from '../src/infra/idempotency';

class MockRedis implements RedisLike {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async set(
    key: string,
    value: string,
    _mode: 'PX',
    ttlMs: number,
    _flag: 'NX',
  ): Promise<'OK' | null> {
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > now) return null;
    this.store.set(key, { value, expiresAt: now + ttlMs });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

describe('Idempotency (Rules 24, 25)', () => {
  it('allows first acquire, rejects the second', async () => {
    const svc = new IdempotencyService(new MockRedis());
    expect(await svc.acquire('req-123')).toBe(true);
    expect(await svc.acquire('req-123')).toBe(false);
  });

  it('allows re-acquire after release', async () => {
    const svc = new IdempotencyService(new MockRedis());
    await svc.acquire('req-456');
    await svc.release('req-456');
    expect(await svc.acquire('req-456')).toBe(true);
  });

  it('treats different ids independently', async () => {
    const svc = new IdempotencyService(new MockRedis());
    expect(await svc.acquire('a')).toBe(true);
    expect(await svc.acquire('b')).toBe(true);
  });
});
