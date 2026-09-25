import { randomUUID } from 'crypto';
import { ProposalOrchestrator } from '../orchestrator/orchestrator';
import { TradeExecutor } from '../execution/executor';
import { Signal } from '../strategy/types';
import { logger as _logger } from '../utils/logger';

import { PositionLedger } from '../state/positions/types';

export interface TradeHandlerDeps {
  orchestrator: ProposalOrchestrator;
  executor: TradeExecutor;
  positions: PositionLedger;
}

export interface TradeRequest {
  userId: number;
  kind: 'BUY' | 'SELL';
  tokenMint: string;
  amountSol?: number;
}

export interface TradeRequestResult {
  ok: boolean;
  message: string;
}

/**
 * Rule 5: user-originated trades follow the exact same pipeline as
 * strategy-originated trades. The Telegram handler is a Signal producer,
 * not an executor. It cannot bypass the Risk Engine.
 *
 * Rule 28: no AI involvement. No shortcuts.
 */
export class TelegramTradeHandler {
  constructor(private readonly deps: TradeHandlerDeps) {}

  async handle(request: TradeRequest): Promise<TradeRequestResult> {
    const amount = request.amountSol ?? 0.05;

    // Rule 35: reject obviously invalid input before producing a Signal.
    if (amount <= 0) {
      return { ok: false, message: 'Amount must be positive.' };
    }
    if (!isLikelyPubkey(request.tokenMint)) {
      return { ok: false, message: 'Invalid token mint.' };
    }

    const signal = this.buildSignal(request, amount);
    const orchResult = await this.deps.orchestrator.process(signal);

    if (orchResult.kind === 'REJECTED') {
      return {
        ok: false,
        message: `Risk Engine rejected: ${orchResult.stored.decision.reason ?? 'UNKNOWN'}`,
      };
    }
    if (orchResult.kind === 'DUPLICATE') {
      return { ok: false, message: 'This request was already processed.' };
    }
    if (orchResult.kind === 'ERROR') {
      return { ok: false, message: `Pipeline error: ${orchResult.reason}` };
    }

    const execResult = await this.deps.executor.execute(orchResult.stored);
    const execKind = (execResult as { kind?: string }).kind ?? 'UNKNOWN';

    if (execKind === 'CONFIRMED') {
      return {
        ok: true,
        message: `✅ Executed (paper). Signature: ${(execResult as any).execution?.txSignature?.slice(0, 12) ?? 'n/a'}…`,
      };
    }
    if (execKind === 'DUPLICATE') {
      return { ok: false, message: 'Already executed.' };
    }
    if (execKind === 'REJECTED') {
      return {
        ok: false,
        message: `Execution blocked: ${(execResult as any).reason}`,
      };
    }
    if (execKind === 'FAILED') {
      return {
        ok: false,
        message: `Execution failed: ${(execResult as any).reason ?? 'Unknown error'}`,
      };
    }
    if (execKind === 'SUBMITTED') {
      return {
        ok: true,
        message: '📤 Submitted — awaiting confirmation.',
      };
    }
    if (execKind === 'UNKNOWN') {
      return {
        ok: false,
        message: '⚠️ Execution UNKNOWN — manual reconciliation required.',
      };
    }

    // Exhaustive fallback for any unexpected executor state.
    return {
      ok: false,
      message: 'Execution failed: unknown executor state.',
    };
  }

  /**
   * Iterates all open positions and routes each through the SELL pipeline.
   * Rule 5: same pipeline, same gates, same executor as a manual /sell.
   * Rule 23: a failure on one position does not abort the others.
   */
  async closeAll(userId: number): Promise<TradeRequestResult> {
    const positions = await this.deps.positions.list();
    if (positions.length === 0) {
      return { ok: true, message: 'No open positions to close.' };
    }

    const results: string[] = [];
    let closed = 0;
    let failed = 0;

    for (const position of positions) {
      try {
        const r = await this.handle({
          userId,
          kind: 'SELL',
          tokenMint: position.tokenMint,
        });
        if (r.ok) {
          closed += 1;
          results.push(`✓ ${position.tokenMint.slice(0, 8)}…`);
        } else {
          failed += 1;
          results.push(`✗ ${position.tokenMint.slice(0, 8)}… — ${r.message}`);
        }
      } catch (err) {
        failed += 1;
        results.push(`✗ ${position.tokenMint.slice(0, 8)}… — unexpected error`);
        _logger.error({ event: 'CLOSEALL_ITEM_FAILED', tokenMint: position.tokenMint, err }, 'close-all item failed');
      }
    }

    return {
      ok: failed === 0,
      message: `Close-all: ${closed} closed, ${failed} failed.\n${results.join('\n')}`,
    };
  }

  private buildSignal(request: TradeRequest, amountSol: number): Signal {
    return {
      id: randomUUID(),
      tokenMint: request.tokenMint,
      strategy: 'TELEGRAM_MANUAL',
      strategyVersion: '1.0.0',
      createdAt: Date.now(),
      side: request.kind,
      score: 0,
      proposedAmountSol: amountSol,
      proposedSlippageBps: 150,
      proposedPriceImpactBps: 200,
      evidence: {
        marketSnapshot: {
          tokenMint: request.tokenMint,
          fetchedAt: Date.now(),
          priceUsd: 0,
          liquidityUsd: 0,
          volume24hUsd: 0,
          priceChange5mPercent: 0,
          priceChange1hPercent: 0,
          holderCount: 0,
          top10HolderPercent: 0,
        },
        indicators: {},
        entryReason: `telegram /${request.kind.toLowerCase()} by user ${request.userId}`,
      },
    };
  }
}

function isLikelyPubkey(s: string): boolean {
  return s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
