import { Authorizer } from './auth';
import { KillSwitchStore } from '../state/killSwitch';
import { PositionLedger } from '../state/positions/types';
import { ProposalStore } from '../state/proposals';
import { ConfirmationManager } from './confirmation';
import { audit } from './audit';

export interface CommandContext {
  userId: number | undefined;
  authorizer: Authorizer;
  killSwitch: KillSwitchStore;
  positions: PositionLedger;
  proposals: ProposalStore;
  confirmations: ConfirmationManager;
  /** Optional: called when /buy or /sell is fully confirmed. Wired in Task 035. */
  onTradeRequest?: (req: {
    userId: number;
    kind: 'BUY' | 'SELL';
    tokenMint: string;
    amountSol?: number;
    /** SELL only: fraction of the position to close, in bps (10000 = full). */
    sellPercentBps?: number;
  }) => Promise<{ ok: boolean; message: string }>;
  /** Optional: called on /closeall. Wired in Task 035. */
  onCloseAll?: (userId: number) => Promise<{ ok: boolean; message: string }>;
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

export const HELP_TEXT = [
  'Commands:',
  '/status     — kill switch + mode',
  '/positions  — open positions',
  '/pause      — activate kill switch',
  '/resume     — deactivate kill switch',
  '/emergency  — activate kill switch with EMERGENCY reason',
  '/buy <mint> <sol>  — propose a buy (requires confirmation)',
  '/sell <mint> [percent] — propose a sell, percent 1-100 (default 100, requires confirmation)',
  '/closeall          — close all open positions (requires typed confirmation)',
  '/help       — this message',
].join('\n');

function requireAuth(
  ctx: CommandContext,
  command: string,
): CommandResult | null {
  const auth = ctx.authorizer.isAuthorized(ctx.userId);
  if (!auth.authorized) {
    audit('CMD_UNAUTHORIZED', { userId: ctx.userId, command });
    return { ok: false, message: 'Unauthorized.' };
  }
  return null;
}

async function requireTradingAllowed(
  ctx: CommandContext,
  command: string,
  side: 'BUY' | 'SELL' = 'BUY',
): Promise<CommandResult | null> {
  const ks = await ctx.killSwitch.get();
  if (ks.active && side === 'BUY') {
    audit('CMD_BLOCKED_KILL_SWITCH', { userId: ctx.userId, command });
    return {
      ok: false,
      message: `🛑 Kill switch active (${ks.reason ?? 'unknown'}). Trade commands blocked.`,
    };
  }
  if (ks.active && side === 'SELL') {
    // Exits are risk-REDUCING: they stay available while the kill switch is
    // active (audit fix C2). Otherwise /emergency would trap open positions
    // with no way to flatten. The executor + risk engine apply the same rule.
    audit('CMD_SELL_UNDER_KILL_SWITCH', { userId: ctx.userId, command });
  }
  return null;
}

// --- Existing commands ---

export async function handleHelp(ctx: CommandContext): Promise<CommandResult> {
  audit('CMD_HELP', { userId: ctx.userId });
  return { ok: true, message: HELP_TEXT };
}

export async function handleStatus(
  ctx: CommandContext,
): Promise<CommandResult> {
  const denied = requireAuth(ctx, 'status');
  if (denied) return denied;
  const state = await ctx.killSwitch.get();
  audit('CMD_STATUS', { userId: ctx.userId, active: state.active });
  return {
    ok: true,
    message: state.active
      ? `🛑 KILL SWITCH ACTIVE\nreason: ${state.reason ?? 'n/a'}\nby: ${state.setBy ?? 'n/a'}`
      : '✅ Kill switch inactive.',
  };
}

export async function handlePause(ctx: CommandContext): Promise<CommandResult> {
  const denied = requireAuth(ctx, 'pause');
  if (denied) return denied;
  await ctx.killSwitch.activate('manual pause', String(ctx.userId));
  audit('CMD_PAUSE', { userId: ctx.userId });
  return { ok: true, message: '🛑 Kill switch ACTIVE.' };
}

export async function handleResume(
  ctx: CommandContext,
): Promise<CommandResult> {
  const denied = requireAuth(ctx, 'resume');
  if (denied) return denied;
  await ctx.killSwitch.deactivate(String(ctx.userId));
  audit('CMD_RESUME', { userId: ctx.userId });
  return { ok: true, message: '✅ Kill switch DEACTIVATED.' };
}

export async function handleEmergency(
  ctx: CommandContext,
): Promise<CommandResult> {
  const denied = requireAuth(ctx, 'emergency');
  if (denied) return denied;
  await ctx.killSwitch.activate('EMERGENCY', String(ctx.userId));
  audit('CMD_EMERGENCY', { userId: ctx.userId });
  return { ok: true, message: '🚨 EMERGENCY MODE ACTIVE.' };
}

// --- New: positions ---

export async function handlePositions(
  ctx: CommandContext,
): Promise<CommandResult> {
  const denied = requireAuth(ctx, 'positions');
  if (denied) return denied;
  const count = await ctx.positions.getOpenCount();
  audit('CMD_POSITIONS', { userId: ctx.userId, count });
  return { ok: true, message: `📊 Open positions: ${count}` };
}

// --- New: buy (two-step) ---

export async function handleBuy(
  ctx: CommandContext,
  args: string[],
): Promise<CommandResult> {
  const denied = requireAuth(ctx, 'buy');
  if (denied) return denied;
  const ksDenied = await requireTradingAllowed(ctx, 'buy');
  if (ksDenied) return ksDenied;

  if (args.length !== 2) {
    return { ok: false, message: 'Usage: /buy <mint> <amountSol>' };
  }
  const [tokenMint, amountStr] = args;
  const amountSol = Number(amountStr);
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    return { ok: false, message: 'amountSol must be a positive number.' };
  }

  const required = 'confirm';
  ctx.confirmations.register(
    ctx.userId!,
    'BUY',
    { tokenMint, amountSol },
    required,
  );
  audit('CMD_BUY_PENDING', { userId: ctx.userId, tokenMint, amountSol });
  return {
    ok: true,
    message: `📝 Buy request prepared:\n  mint: ${tokenMint}\n  amount: ${amountSol} SOL\n\nReply exactly "confirm" within 60s to execute.`,
  };
}

export async function handleSell(
  ctx: CommandContext,
  args: string[],
): Promise<CommandResult> {
  const denied = requireAuth(ctx, 'sell');
  if (denied) return denied;
  const ksDenied = await requireTradingAllowed(ctx, 'sell', 'SELL');
  if (ksDenied) return ksDenied;

  if (args.length < 1 || args.length > 2) {
    return { ok: false, message: 'Usage: /sell <mint> [percent 1-100]' };
  }
  const [tokenMint, percentStr] = args;

  // Partial close support (audit fix M7): percent of the held position,
  // in basis points. Default = full close (10000 bps).
  let sellPercentBps = 10_000;
  if (percentStr !== undefined) {
    const pct = Number(percentStr.replace('%', ''));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return {
        ok: false,
        message: 'percent must be a number between 1 and 100.',
      };
    }
    sellPercentBps = Math.round(pct * 100);
  }

  const required = 'confirm';
  ctx.confirmations.register(
    ctx.userId!,
    'SELL',
    { tokenMint, sellPercentBps },
    required,
  );
  audit('CMD_SELL_PENDING', { userId: ctx.userId, tokenMint, sellPercentBps });
  const pctLabel =
    sellPercentBps === 10_000 ? '100' : String(sellPercentBps / 100);
  return {
    ok: true,
    message: `📝 Sell request prepared:\n  mint: ${tokenMint}\n  percent: ${pctLabel}%\n\nReply exactly "confirm" within 60s to execute.`,
  };
}

export async function handleCloseAll(
  ctx: CommandContext,
): Promise<CommandResult> {
  const denied = requireAuth(ctx, 'closeall');
  if (denied) return denied;
  const ksDenied = await requireTradingAllowed(ctx, 'closeall', 'SELL');
  if (ksDenied) return ksDenied;

  const required = 'CONFIRM CLOSE ALL';
  ctx.confirmations.register(ctx.userId!, 'CLOSE_ALL', {}, required);
  audit('CMD_CLOSEALL_PENDING', { userId: ctx.userId });
  return {
    ok: true,
    message: `🚨 Close-all prepared.\n\nType EXACTLY:\n${required}\n\nwithin 60s to execute.`,
  };
}

// --- Confirmation handler for free-text messages ---

export async function handleConfirmationText(
  ctx: CommandContext,
  text: string,
): Promise<CommandResult | null> {
  if (!ctx.userId) return null;
  const trimmed = text.trim();

  // Check each kind in order of specificity: CLOSE_ALL first (longest required text).
  for (const kind of ['CLOSE_ALL', 'SELL', 'BUY'] as const) {
    const consumed = ctx.confirmations.consume<Record<string, unknown>>(
      ctx.userId,
      kind,
      trimmed,
    );
    if (!consumed) continue;

    // Audit fix M5: the kill switch was checked when the proposal was
    // registered — re-check at EXECUTION time too, or a pause issued between
    // /buy and "confirm" would be silently bypassed at this layer.
    // Side-aware (C2): BUYs are blocked under the kill switch, SELLs are
    // allowed (exits reduce risk).
    const ksDenied = await requireTradingAllowed(
      ctx,
      kind.toLowerCase(),
      kind === 'BUY' ? 'BUY' : 'SELL',
    );
    if (ksDenied) return ksDenied;

    if (kind === 'CLOSE_ALL') {
      if (!ctx.onCloseAll) {
        return { ok: false, message: 'Close-all handler not wired yet.' };
      }
      const result = await ctx.onCloseAll(ctx.userId);
      audit('CMD_CLOSEALL_EXECUTED', { userId: ctx.userId, ok: result.ok });
      return result;
    }

    if (kind === 'BUY' || kind === 'SELL') {
      if (!ctx.onTradeRequest) {
        return { ok: false, message: 'Trade handler not wired yet.' };
      }
      const payload = consumed.payload as {
        tokenMint: string;
        amountSol?: number;
        sellPercentBps?: number;
      };
      const result = await ctx.onTradeRequest({
        userId: ctx.userId,
        kind,
        tokenMint: payload.tokenMint,
        amountSol: payload.amountSol,
        sellPercentBps: payload.sellPercentBps,
      });
      audit(`CMD_${kind}_EXECUTED`, {
        userId: ctx.userId,
        ok: result.ok,
        tokenMint: payload.tokenMint,
        sellPercentBps: payload.sellPercentBps,
      });
      return result;
    }
  }

  return null;
}
