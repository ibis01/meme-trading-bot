import { Authorizer } from '../src/telegram/auth';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPositionLedger } from '../src/state/positions/inMemoryLedger';
import { InMemoryProposalStore } from '../src/state/proposals';
import { ConfirmationManager } from '../src/telegram/confirmation';
import {
  CommandContext,
  handleBuy,
  handleConfirmationText,
  handleEmergency,
  handleHelp,
  handlePause,
  handleResume,
  handleSell,
  handleStatus,
} from '../src/telegram/commands';

function mkCtx(
  userId: number | undefined,
  allowed: number[] = [111],
): CommandContext {
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

// --- Audit fixes M5 / M7 / C2: sell percent, KS recheck at confirm, side-aware KS ---

function mkSellCtx(userId: number | undefined, allowed: number[] = [111]) {
  return {
    ...mkCtx(userId, allowed),
    onTradeRequest: undefined as CommandContext['onTradeRequest'],
  };
}

describe('/sell percent parsing (audit fix M7)', () => {
  it('registers a full close by default', async () => {
    const ctx = mkSellCtx(111);
    const r = await handleSell(ctx, ['SomeMintAddress111111111111111111111']);
    expect(r.ok).toBe(true);
    const pending = ctx.confirmations.peek(111, 'SELL');
    expect(pending?.payload).toMatchObject({ sellPercentBps: 10_000 });
  });

  it('parses a 50% partial close into 5000 bps', async () => {
    const ctx = mkSellCtx(111);
    const r = await handleSell(ctx, [
      'SomeMintAddress111111111111111111111',
      '50',
    ]);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('50%');
    const pending = ctx.confirmations.peek(111, 'SELL');
    expect(pending?.payload).toMatchObject({ sellPercentBps: 5_000 });
  });

  it('accepts a % suffix', async () => {
    const ctx = mkSellCtx(111);
    const r = await handleSell(ctx, [
      'SomeMintAddress111111111111111111111',
      '25%',
    ]);
    expect(r.ok).toBe(true);
    expect(ctx.confirmations.peek(111, 'SELL')?.payload).toMatchObject({
      sellPercentBps: 2_500,
    });
  });

  it('rejects out-of-range percentages', async () => {
    const ctx = mkSellCtx(111);
    expect(
      (await handleSell(ctx, ['SomeMintAddress111111111111111111111', '0'])).ok,
    ).toBe(false);
    expect(
      (await handleSell(ctx, ['SomeMintAddress111111111111111111111', '150']))
        .ok,
    ).toBe(false);
    expect(
      (await handleSell(ctx, ['SomeMintAddress111111111111111111111', 'abc']))
        .ok,
    ).toBe(false);
  });
});

describe('kill-switch semantics at confirmation time (audit fixes M5 + C2)', () => {
  const MINT_OK = 'SomeMintAddress111111111111111111111';

  it('a BUY confirmed AFTER the kill switch tripped is blocked at the Telegram layer', async () => {
    const ctx = mkSellCtx(111);
    await handleBuy(ctx, [MINT_OK, '0.05']);
    await ctx.killSwitch.activate('EMERGENCY', 'operator');
    const r = await handleConfirmationText(ctx, 'confirm');
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain('Kill switch active');
    // onTradeRequest never wired → if the gate had been bypassed we'd see a
    // "not wired yet" message instead.
  });

  it('a SELL confirmed AFTER the kill switch tripped is still executable (C2)', async () => {
    const ctx = mkSellCtx(111);
    await handleSell(ctx, [MINT_OK]);
    await ctx.killSwitch.activate('EMERGENCY', 'operator');
    const executed: unknown[] = [];
    ctx.onTradeRequest = async (req) => {
      executed.push(req);
      return { ok: true, message: 'sold' };
    };
    const r = await handleConfirmationText(ctx, 'confirm');
    expect(r!.ok).toBe(true);
    expect(executed).toHaveLength(1);
  });
});
