import { RedisLike } from '../infra/idempotency';

/**
 * Rule 14: Kill switch must be enforceable outside the strategy engine.
 * Stored in Redis so any process can read/write it, and it survives restarts.
 */
export interface KillSwitchState {
  active: boolean;
  reason?: string;
  setBy?: string;
  setAt?: number;
}

export interface KillSwitchStore {
  get(): Promise<KillSwitchState>;
  activate(reason: string, setBy: string): Promise<void>;
  deactivate(setBy: string): Promise<void>;
}

const KEY = 'killswitch:state';

export class InMemoryKillSwitch implements KillSwitchStore {
  private state: KillSwitchState = { active: false };
  async get() {
    return { ...this.state };
  }
  async activate(reason: string, setBy: string) {
    this.state = { active: true, reason, setBy, setAt: Date.now() };
  }
  async deactivate(setBy: string) {
    this.state = { active: false, setBy, setAt: Date.now() };
  }
}

export class RedisKillSwitch implements KillSwitchStore {
  constructor(
    private readonly redis: RedisLike & {
      get(key: string): Promise<string | null>;
      set(key: string, value: string): Promise<'OK' | null>;
    },
  ) {}

  async get(): Promise<KillSwitchState> {
    const raw = await this.redis.get(KEY);
    return raw ? (JSON.parse(raw) as KillSwitchState) : { active: false };
  }

  async activate(reason: string, setBy: string): Promise<void> {
    const next: KillSwitchState = {
      active: true,
      reason,
      setBy,
      setAt: Date.now(),
    };
    await this.redis.set(KEY, JSON.stringify(next));
  }

  async deactivate(setBy: string): Promise<void> {
    const next: KillSwitchState = { active: false, setBy, setAt: Date.now() };
    await this.redis.set(KEY, JSON.stringify(next));
  }
}

/**
 * Audit fix M4: when Redis (or any backing store) is unavailable, the raw
 * RedisKillSwitch THROWS on get() — which previously meant:
 *   - every trade path threw an opaque error, and
 *   - /status, /pause, /emergency themselves failed, so the operator lost
 *     all visibility and control exactly during an infrastructure incident.
 *
 * This wrapper makes store outages SAFE and legible:
 *   - reads fail CLOSED: if the store cannot be reached, treat the switch as
 *     ACTIVE with an explicit reason (blocks new entries — the safe default),
 *     using the last known state if one was ever read;
 *   - writes still require the store (deactivation during an outage is
     intentionally impossible — do not resume trading on stale state).
 */
export class ResilientKillSwitch implements KillSwitchStore {
  private lastKnown: KillSwitchState | null = null;

  constructor(
    private readonly inner: KillSwitchStore,
    private readonly onError?: (err: unknown) => void,
  ) {}

  async get(): Promise<KillSwitchState> {
    try {
      const state = await this.inner.get();
      this.lastKnown = state;
      return state;
    } catch (err) {
      this.onError?.(err);
      if (this.lastKnown?.active) {
        return {
          ...this.lastKnown,
          reason: `${this.lastKnown.reason ?? 'unknown'} (store unavailable — last known state)`,
        };
      }
      return {
        active: true,
        reason: 'KILL_SWITCH_STORE_UNAVAILABLE',
        setBy: 'system',
        setAt: Date.now(),
      };
    }
  }

  async activate(reason: string, setBy: string): Promise<void> {
    await this.inner.activate(reason, setBy);
    this.lastKnown = { active: true, reason, setBy, setAt: Date.now() };
  }

  async deactivate(setBy: string): Promise<void> {
    await this.inner.deactivate(setBy);
    this.lastKnown = { active: false, setBy, setAt: Date.now() };
  }
}
