import { InMemoryKillSwitch } from '../src/state/killSwitch';

describe('KillSwitchStore (Rule 14)', () => {
  it('starts inactive', async () => {
    expect((await new InMemoryKillSwitch().get()).active).toBe(false);
  });

  it('activates with reason and setBy', async () => {
    const ks = new InMemoryKillSwitch();
    await ks.activate('EMERGENCY', '42');
    const s = await ks.get();
    expect(s.active).toBe(true);
    expect(s.reason).toBe('EMERGENCY');
    expect(s.setBy).toBe('42');
  });

  it('deactivates', async () => {
    const ks = new InMemoryKillSwitch();
    await ks.activate('x', '1');
    await ks.deactivate('1');
    expect((await ks.get()).active).toBe(false);
  });
});
