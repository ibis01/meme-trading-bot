import { Authorizer } from '../src/telegram/auth';
import { InMemoryKillSwitch } from '../src/state/killSwitch';
import { InMemoryPositionLedger } from '../src/state/positions/inMemoryLedger';
import { InMemoryProposalStore } from '../src/state/proposals';
import { ConfirmationManager } from '../src/telegram/confirmation';
import {
  CommandContext,
  handleBuy,
  handleCloseAll,
  handleConfirmationText,
  handlePositions,
  handleSell,
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

describe('Trade control commands (Rule 13)', () => {
  it('/positions rejects unauthorized', async () => {
    const r = await handlePositions(mkCtx(999));
    expect(r.ok).toBe(false);
  });

  it('/positions returns count', async () => {
    const r = await handlePositions(mkCtx(111));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/0/);
  });

  it('/buy requires two args', async () => {
    const r = await handleBuy(mkCtx(111), ['onlymint']);
    expect(r.ok).toBe(false);
  });

  it('/buy rejects non-numeric amount', async () => {
    const r = await handleBuy(mkCtx(111), ['mint', 'abc']);
    expect(r.ok).toBe(false);
  });

  it('/buy registers a pending confirmation', async () => {
    const ctx = mkCtx(111);
    const r = await handleBuy(ctx, ['mint', '0.1']);
    expect(r.ok).toBe(true);
    expect(ctx.confirmations.peek(111, 'BUY')).toBeDefined();
  });

  it('/buy is blocked when kill switch is active', async () => {
    const ctx = mkCtx(111);
    await ctx.killSwitch.activate('EMERGENCY', '111');
    const r = await handleBuy(ctx, ['mint', '0.1']);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Kill switch/);
  });

  it('/closeall requires the exact phrase to execute', async () => {
    let called = 0;
    const ctx: CommandContext = {
      ...mkCtx(111),
      onCloseAll: async () => { called++; return { ok: true, message: 'closed' }; },
    };
    await handleCloseAll(ctx);
    // Wrong phrase → nothing happens
    const wrong = await handleConfirmationText(ctx, 'confirm');
    expect(wrong).toBeNull();
    expect(called).toBe(0);
    // Exact phrase → callback fires
    const right = await handleConfirmationText(ctx, 'CONFIRM CLOSE ALL');
    expect(right?.ok).toBe(true);
    expect(called).toBe(1);
  });

  it('/buy confirmation routes to onTradeRequest', async () => {
    let received: { kind: 'BUY' | 'SELL'; tokenMint: string; amountSol?: number } | null = null;
    const ctx: CommandContext = {
      ...mkCtx(111),
      onTradeRequest: async (req) => {
        received = req;
        return { ok: true, message: 'executed' };
      },
    };
    await handleBuy(ctx, ['mintX', '0.5']);
    const r = await handleConfirmationText(ctx, 'confirm');
    expect(r?.ok).toBe(true);
    expect(received).toEqual({ userId: 111, kind: 'BUY', tokenMint: 'mintX', amountSol: 0.5 });
  });

  it('/sell confirmation routes to onTradeRequest', async () => {
    let kind: string | null = null;
    const ctx: CommandContext = {
      ...mkCtx(111),
      onTradeRequest: async (req) => { kind = req.kind; return { ok: true, message: 'ok' }; },
    };
    await handleSell(ctx, ['mintY']);
    await handleConfirmationText(ctx, 'confirm');
    expect(kind).toBe('SELL');
  });

  it('unauthorized confirmation text does nothing', async () => {
    const ctx = mkCtx(999); // not authorized
    const r = await handleConfirmationText(ctx, 'CONFIRM CLOSE ALL');
    expect(r).toBeNull();
  });
});
