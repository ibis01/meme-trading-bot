import { Authorizer } from '../src/telegram/auth';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPositionLedger } from '../src/state/positions/inMemoryLedger';
import { InMemoryProposalStore } from '../src/state/proposals';
import { ConfirmationManager } from '../src/telegram/confirmation';
import {
  CommandContext,
  handleEmergency,
  handleHelp,
  handlePause,
  handleResume,
  handleStatus,
} from '../src/telegram/commands';

function mkCtx(userId: number | undefined, allowed: number[] = [111]): CommandContext {
  return {
    userId,
    authorizer: new Authorizer(allowed),
    killSwitch: new InMemoryKillSwitch(),
    positions: new InMemoryPositionLedger(),
    proposals: new InMemoryProposalStore(),
    confirmations: new ConfirmationManager(60_000),
  };
}

describe('Telegram commands (Rules 13, 14)', () => {
  it('/help responds without auth', async () => {
    const r = await handleHelp(mkCtx(undefined));
    expect(r.ok).toBe(true);
  });

  it('/status rejects unauthorized', async () => {
    const r = await handleStatus(mkCtx(999));
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Unauthorized.');
  });

  it('/status reports inactive by default', async () => {
    const r = await handleStatus(mkCtx(111));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/inactive/i);
  });

  it('/pause activates kill switch', async () => {
    const ctx = mkCtx(111);
    await handlePause(ctx);
    expect((await ctx.killSwitch.get()).active).toBe(true);
  });

  it('/resume deactivates kill switch', async () => {
    const ctx = mkCtx(111);
    await handlePause(ctx);
    await handleResume(ctx);
    expect((await ctx.killSwitch.get()).active).toBe(false);
  });

  it('/emergency activates with EMERGENCY reason', async () => {
    const ctx = mkCtx(111);
    await handleEmergency(ctx);
    expect((await ctx.killSwitch.get()).reason).toBe('EMERGENCY');
  });

  it('/pause rejects unauthorized user', async () => {
    const ctx = mkCtx(999);
    const r = await handlePause(ctx);
    expect(r.ok).toBe(false);
    expect((await ctx.killSwitch.get()).active).toBe(false);
  });
});
