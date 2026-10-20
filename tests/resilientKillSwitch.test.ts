import {
  ResilientKillSwitch,
  KillSwitchStore,
  KillSwitchState,
} from '../src/state/killSwitch';

/** Store whose reads/writes can be made to throw on demand. */
class FaultyStore implements KillSwitchStore {
  private state: KillSwitchState = { active: false };
  failReads = false;
  failWrites = false;
  readCount = 0;

  async get(): Promise<KillSwitchState> {
    this.readCount += 1;
    if (this.failReads) throw new Error('REDIS_CONNECTION_LOST');
    return { ...this.state };
  }
  async activate(reason: string, setBy: string): Promise<void> {
    if (this.failWrites) throw new Error('REDIS_CONNECTION_LOST');
    this.state = { active: true, reason, setBy, setAt: Date.now() };
  }
  async deactivate(setBy: string): Promise<void> {
    if (this.failWrites) throw new Error('REDIS_CONNECTION_LOST');
    this.state = { active: false, setBy, setAt: Date.now() };
  }
}

describe('ResilientKillSwitch (audit fix M4)', () => {
  it('passes through to the inner store while it is healthy', async () => {
    const inner = new FaultyStore();
    const ks = new ResilientKillSwitch(inner);
    await ks.activate('test', '1');
    expect((await ks.get()).active).toBe(true);
    await ks.deactivate('1');
    expect((await ks.get()).active).toBe(false);
  });

  it('fails CLOSED with an explicit reason when the store is down (no prior state)', async () => {
    const inner = new FaultyStore();
    inner.failReads = true;
    const ks = new ResilientKillSwitch(inner);
    const state = await ks.get();
    expect(state.active).toBe(true); // blocks new entries — the safe default
    expect(state.reason).toBe('KILL_SWITCH_STORE_UNAVAILABLE');
    expect(state.setBy).toBe('system');
  });

  it('falls back to the last known ACTIVE state with a staleness marker', async () => {
    const inner = new FaultyStore();
    const ks = new ResilientKillSwitch(inner);
    await ks.activate('EMERGENCY', 'operator');
    inner.failReads = true;
    const state = await ks.get();
    expect(state.active).toBe(true);
    expect(state.reason).toContain('EMERGENCY');
    expect(state.reason).toContain('store unavailable');
  });

  it('does NOT resume trading on stale state: outage after healthy inactive read still fails closed', async () => {
    const inner = new FaultyStore();
    const ks = new ResilientKillSwitch(inner);
    await ks.deactivate('operator'); // last known = inactive
    inner.failReads = true;
    const state = await ks.get();
    expect(state.active).toBe(true);
    expect(state.reason).toBe('KILL_SWITCH_STORE_UNAVAILABLE');
  });

  it('reports errors through the onError hook for observability', async () => {
    const inner = new FaultyStore();
    inner.failReads = true;
    const errors: unknown[] = [];
    const ks = new ResilientKillSwitch(inner, (err) => errors.push(err));
    await ks.get();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('REDIS_CONNECTION_LOST');
  });

  it('writes still require the store — deactivation during an outage throws', async () => {
    const inner = new FaultyStore();
    const ks = new ResilientKillSwitch(inner);
    inner.failWrites = true;
    await expect(ks.deactivate('operator')).rejects.toThrow(
      'REDIS_CONNECTION_LOST',
    );
  });
});
