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
  async get() { return { ...this.state }; }
  async activate(reason: string, setBy: string) {
    this.state = { active: true, reason, setBy, setAt: Date.now() };
  }
  async deactivate(setBy: string) {
    this.state = { active: false, setBy, setAt: Date.now() };
  }
}

export class RedisKillSwitch implements KillSwitchStore {
  constructor(private readonly redis: RedisLike & {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<'OK' | null>;
  }) {}

  async get(): Promise<KillSwitchState> {
    const raw = await this.redis.get(KEY);
    return raw ? (JSON.parse(raw) as KillSwitchState) : { active: false };
  }

  async activate(reason: string, setBy: string): Promise<void> {
    const next: KillSwitchState = { active: true, reason, setBy, setAt: Date.now() };
    await this.redis.set(KEY, JSON.stringify(next));
  }

  async deactivate(setBy: string): Promise<void> {
    const next: KillSwitchState = { active: false, setBy, setAt: Date.now() };
    await this.redis.set(KEY, JSON.stringify(next));
  }
}
