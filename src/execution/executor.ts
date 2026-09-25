import { randomUUID } from 'crypto';
import { RiskEngine } from '../risk/engine';
import { KillSwitchStore } from '../state/killSwitch';
import { PositionLedger } from '../state/positions/types';
import { ProposalStore, StoredProposal } from '../state/proposals';
import { ExecutionStore, StoredExecution } from '../state/executions';
import { PnlStore } from '../state/dailyPnl';
import { computeRealizedPnlSol } from './realizedPnl';
import { IdempotencyService } from '../infra/idempotency';
import { ExecutionProvider } from './types';
import { logger } from '../utils/logger';

export interface TradeExecutorDeps {
  riskEngine: RiskEngine;
  killSwitch: KillSwitchStore;
  positions: PositionLedger;
  proposals: ProposalStore;
  executions: ExecutionStore;
  idempotency: IdempotencyService;
  provider: ExecutionProvider;
  /** Rule 7: confirmed fills must reconcile into daily P&L. */
  pnl: PnlStore;
}

export type ExecuteResult =
  | { kind: 'CONFIRMED'; execution: StoredExecution }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'DUPLICATE'; execution: StoredExecution }
  | { kind: 'FAILED'; reason: string };

/**
 * Rule 11: QUOTE → VALIDATE → SIMULATE → CHECK SLIPPAGE → ... → SIGN → SUBMIT → CONFIRM → VERIFY.
 * Rule 12: signing is delegated to the provider; no keys touch this class.
 * Rule 14: kill switch is re-read immediately before submission.
 * Rule 25: exec:<tradeRequestId> idempotency prevents double submission.
 */
export class TradeExecutor {
  constructor(private readonly deps: TradeExecutorDeps) {}

  private execKey(tradeRequestId: string): string {
    return `exec:${tradeRequestId}`;
  }

  async execute(proposal: StoredProposal): Promise<ExecuteResult> {
    // --- Stage 1: VALIDATE ---
    if (proposal.status !== 'APPROVED') {
      return { kind: 'REJECTED', reason: `PROPOSAL_NOT_APPROVED:${proposal.status}` };
    }

    // --- Stage 2: idempotency (Rule 25) ---
    const firstTime = await this.deps.idempotency.acquire(this.execKey(proposal.tradeRequestId));
    if (!firstTime) {
      const existing = await this.deps.executions.getByRequestId(proposal.tradeRequestId);
      if (existing) return { kind: 'DUPLICATE', execution: existing };
      return { kind: 'FAILED', reason: 'DUPLICATE_IN_FLIGHT' };
    }

    try {
      // --- Stage 3: kill switch recheck (Rule 11 + 14) ---
      const ks = await this.deps.killSwitch.get();
      if (ks.active) {
        logger.warn(
          { event: 'EXECUTION_BLOCKED', tradeRequestId: proposal.tradeRequestId, reason: 'KILL_SWITCH_ACTIVE' },
          'Execution blocked by kill switch',
        );
        return { kind: 'REJECTED', reason: 'KILL_SWITCH_ACTIVE' };
      }

      // --- Stage 4: re-run risk engine (catches stale quotes) ---
      const fresh = await this.deps.riskEngine.evaluate(proposal.proposal);
      if (!fresh.allowed) {
        logger.warn(
          { event: 'EXECUTION_BLOCKED', tradeRequestId: proposal.tradeRequestId, reason: fresh.reason },
          'Execution blocked by risk re-evaluation',
        );
        return { kind: 'REJECTED', reason: fresh.reason ?? 'RISK_REJECTED' };
      }

      // --- Stage 5: provider safety gate (Rule 34) ---
      this.deps.provider.assertEnabled();

      // --- Stage 6: SUBMIT ---
      const outcome = await this.deps.provider.execute({
        tradeRequestId: proposal.tradeRequestId,
        tokenMint: proposal.proposal.tokenMint,
        side: proposal.proposal.side,
        amountSol: proposal.proposal.amountSol,
        maxSlippageBps: proposal.proposal.expectedSlippageBps,
        maxPriceImpactBps: proposal.proposal.expectedPriceImpactBps,
        quoteFetchedAt: proposal.proposal.quoteFetchedAt,
      });

      // --- Stage 7: CONFIRM + VERIFY ---
      const stored: StoredExecution = {
        id: randomUUID(),
        proposalId: proposal.id,
        tradeRequestId: proposal.tradeRequestId,
        txSignature: outcome.txSignature,
        status: outcome.status,
        error: outcome.error,
        executedAt: Date.now(),
      };

      // Rule 24: refuse to persist a duplicate tx signature.
      const clash = await this.deps.executions.getBySignature(outcome.txSignature);
      if (clash) {
        logger.error(
          { event: 'DUPLICATE_SIGNATURE', tradeRequestId: proposal.tradeRequestId, txSignature: outcome.txSignature },
          'Duplicate tx signature detected — refusing to persist',
        );
        return { kind: 'FAILED', reason: 'DUPLICATE_TX_SIGNATURE' };
      }

      await this.deps.executions.save(stored);

      if (outcome.status === 'CONFIRMED') {
        await this.deps.proposals.updateStatus(proposal.id, 'EXECUTED');

        // Rule 15 / Rule 7: update the ledger and reconcile realized P&L.
        // Rule 23: a bookkeeping failure must not invalidate a real fill —
        // log it loudly and continue. The daily loss gate will be stale until
        // a reconciliation pass corrects it.
        try {
          if (proposal.proposal.side === 'BUY') {
            // P0-4b interim model: quantity == SOL notional, priceSol == 1.
            // When live execution lands, the provider will report units and
            // price-per-unit separately and the ledger will track them natively.
            await this.deps.positions.open({
              tokenMint: proposal.proposal.tokenMint,
              tradeRequestId: proposal.tradeRequestId,
              quantity: outcome.filledAmountSol,
              priceSol: 1,
              signature: outcome.txSignature,
            });
          } else {
            const held = await this.deps.positions.get(proposal.proposal.tokenMint);
            if (held && held.quantity > 0) {
              const closeResult = await this.deps.positions.close({
                tokenMint: proposal.proposal.tokenMint,
                tradeRequestId: proposal.tradeRequestId,
                quantity: held.quantity,
                priceSol: 1,
                signature: outcome.txSignature,
              });
              await this.deps.pnl.addSol(closeResult.realizedPnlSol);
              logger.info(
                {
                  event: 'PNL_RECORDED',
                  tradeRequestId: proposal.tradeRequestId,
                  realizedSol: closeResult.realizedPnlSol,
                },
                'Realized PnL recorded',
              );
            } else {
              logger.warn(
                { event: 'SELL_WITHOUT_POSITION', tradeRequestId: proposal.tradeRequestId },
                'Sell filled but no position was on record — PnL not reconciled',
              );
            }
          }
        } catch (err) {
          logger.error(
            { event: 'LEDGER_RECONCILE_FAILED', tradeRequestId: proposal.tradeRequestId, err },
            'Failed to reconcile position/PnL — gate will be stale until corrected',
          );
        }
        logger.info(
          { event: 'EXECUTION_CONFIRMED', tradeRequestId: proposal.tradeRequestId, txSignature: outcome.txSignature, provider: this.deps.provider.name },
          'Execution confirmed',
        );
        return { kind: 'CONFIRMED', execution: stored };
      }

      await this.deps.proposals.updateStatus(proposal.id, 'FAILED');
      logger.error(
        { event: 'EXECUTION_FAILED', tradeRequestId: proposal.tradeRequestId, error: outcome.error },
        'Execution failed at provider',
      );
      return { kind: 'FAILED', reason: outcome.error ?? 'PROVIDER_FAILED' };
    } catch (err) {
      await this.deps.idempotency.release(this.execKey(proposal.tradeRequestId));
      const reason = err instanceof Error ? err.message : 'UNKNOWN';
      logger.error({ event: 'EXECUTION_ERROR', tradeRequestId: proposal.tradeRequestId, err }, 'Executor threw');
      return { kind: 'FAILED', reason };
    }
  }
}
