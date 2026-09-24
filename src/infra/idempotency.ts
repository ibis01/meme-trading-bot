export interface RedisLike {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    flag: 'NX',
  ): Promise<'OK' | null>;
  del(key: string): Promise<number>;
}

export class IdempotencyService {
  constructor(
    private readonly redis: RedisLike,
    private readonly ttlMs: number = 24 * 60 * 60 * 1000,
  ) {}

  private key(id: string): string {
    return `idem:${id}`;
  }

  async acquire(tradeRequestId: string): Promise<boolean> {
    const result = await this.redis.set(
      this.key(tradeRequestId),
      '1',
      'PX',
      this.ttlMs,
      'NX',
    );
    return result === 'OK';
  }

  async release(tradeRequestId: string): Promise<void> {
    await this.redis.del(this.key(tradeRequestId));
  }
}

export function newTradeRequestId(): string {
  return `tr_${crypto.randomUUID()}`;
}
