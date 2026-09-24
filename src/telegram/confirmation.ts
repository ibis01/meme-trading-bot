export interface PendingConfirmation<T = unknown> {
  userId: number;
  createdAt: number;
  expiresAt: number;
  kind: 'BUY' | 'SELL' | 'CLOSE_ALL';
  payload: T;
  requiredText: string;
}

export class ConfirmationManager {
  private readonly pending = new Map<string, PendingConfirmation>();
  constructor(private readonly ttlMs: number = 60_000) {}

  private key(userId: number, kind: string): string {
    return `${userId}:${kind}`;
  }

  register<T>(
    userId: number,
    kind: PendingConfirmation['kind'],
    payload: T,
    requiredText: string,
  ): PendingConfirmation<T> {
    const now = Date.now();
    const entry: PendingConfirmation<T> = {
      userId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      kind,
      payload,
      requiredText,
    };
    this.pending.set(this.key(userId, kind), entry as PendingConfirmation);
    return entry;
  }

  /**
   * Consume a pending confirmation. Deletes ONLY on success.
   * Returns null if:
   *  - no pending exists for (userId, kind)
   *  - it expired (and it will be purged)
   *  - requiredText doesn't match (pending is preserved for retry)
   */
  consume<T>(
    userId: number,
    kind: PendingConfirmation['kind'],
    providedText: string,
  ): PendingConfirmation<T> | null {
    const k = this.key(userId, kind);
    const entry = this.pending.get(k);
    if (!entry) return null;

    // Purge on expiry, but do not consume on text mismatch.
    if (entry.expiresAt < Date.now()) {
      this.pending.delete(k);
      return null;
    }
    if (entry.requiredText.toLowerCase() !== providedText.trim().toLowerCase()) {
      return null;
    }
    this.pending.delete(k);
    return entry as PendingConfirmation<T>;
  }

  peek(userId: number, kind: PendingConfirmation['kind']): PendingConfirmation | undefined {
    const entry = this.pending.get(this.key(userId, kind));
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.pending.delete(this.key(userId, kind));
      return undefined;
    }
    return entry;
  }

  clear(): void {
    this.pending.clear();
  }
}
