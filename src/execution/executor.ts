import { randomUUID } from 'crypto';
import { RiskEngine } from '../risk/engine';
import { KillSwitchStore } from '../state/killSwitch';
import { PositionLedger } from '../state/positions/types';
import { ProposalStore, StoredProposal } from '../state/proposals';
import { ExecutionStore, StoredExecution } from '../state/executions';
import { PnlStore } from '../state/dailyPnl';
import { IdempotencyService } from '../infra/idempotency';
import { ExecutionProvider, ExecutionStatus } from './types';
import { logger } from '../utils/logger';

export interface TradeExecutorDeps {
  riskEngine: RiskEngine;
  killSwitch: KillSwitchStore;
  positions: PositionLedger;
  proposals: ProposalStore;
  executions: ExecutionStore;
  idempotency: IdempotencyService;
  provider: ExecutionProvider;
  pnl: PnlStore;
}

export type ExecuteResult =
  | { kind: 'CONFIRMED'; execution: StoredExecution }
  | { kind: 'SUBMITTED'; execution: StoredExecution }
  | { kind: 'UNKNOWN'; execution: StoredExecution }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'DUPLICATE'; execution: StoredExecution }
  | { kind: 'FAILED'; reason: string };

/**
 * Rule 11: executor honors a four-state submission model.
 * Rule 24: pre-submit failures release the idempotency lock (safe to retry).
 *          post-submit failures NEVER release the lock (retry could double-submit).
 */
export class TradeExecutor {
  constructor(private readonly deps: TradeExecutorDeps) {}

  private execKey(tradeRequestId: string): string {
    return `exec:${tradeRequestId}`;
  }

  async execute(proposal: StoredProposal): Promise<ExecuteResult> {
    // Stage 1: VALIDATE (no side effects)
    if (proposal.status !== 'APPROVED') {
      return { kind: 'REJECTED', reason: `PROPOSAL_NOT_APPROVED:${proposal.status}` };
    }

    // Stage 2: idempotency acquire
    const firstTime = await this.deps.idempotency.acquire(this.execKey(proposal.tradeRequestId));
    if (!firstTime) {
      const existing = await this.deps.executions.getByRequestId(proposal.tradeRequestId);
      if (existing) {
        // Re-route to the correct result kind based on the persisted status.
        if (existing.status === 'CONFIRMED') return { kind: 'CONFIRMED', execution: existing };
        if (existing.status === 'SUBMITTED') return { kind: 'SUBMITTED', execution: existing };
        if (existing.status === 'UNKNOWN') return { kind: 'UNKNOWN', execution: existing };
        return { kind: 'DUPLICATE', execution: existing };
      }
      return { kind: 'FAILED', reason: 'DUPLICATE_IN_FLIGHT' };
    }

    // Anything from here until `submitStarted = true` is pre-submit and safe
    // to release the lock on rejection.
    let submitStarted = false;

    try {
      // Stage 3: kill switch recheck (Rule 14)
      const ks = await this.deps.killSwitch.get();
      if (ks.active) {
        await this.deps.idempotency.release(this.execKey(proposal.tradeRequestId));
        logger.warn(
          { event: 'EXECUTION_BLOCKED', tradeRequestId: proposal.tradeRequestId, reason: 'KILL_SWITCH_ACTIVE' },
          'Execution blocked by kill switch',
        );
        return { kind: 'REJECTED', reason: 'KILL_SWITCH_ACTIVE' };
      }

      // Stage 4: risk re-evaluation (catches stale quotes)
      const fresh = await this.deps.riskEngine.evaluate(proposal.proposal);
      if (!fresh.allowed) {
        await this.deps.idempotency.release(this.execKey(proposal.tradeRequestId));
        logger.warn(
          { event: 'EXECUTION_BLOCKED', tradeRequestId: proposal.tradeRequestId, reason: fresh.reason },
          'Execution blocked by risk re-evaluation',
        );
        return { kind: 'REJECTED', reason: fresh.reason ?? 'RISK_REJECTED' };
      }

      // Stage 5: provider safety gate (Rule 34)
      this.deps.provider.assertEnabled();

      // === POINT OF NO RETURN ===
      // From this line onward we DO NOT release the idempotency lock, even on
      // rejection, because a submission attempt may have reached the network.
      submitStarted = true;

      // Stage 6: SUBMIT
      const outcome = await this.deps.provider.execute({
        tradeRequestId: proposal.tradeRequestId,
        tokenMint: proposal.proposal.tokenMint,
        side: proposal.proposal.side,
        amountSol: proposal.proposal.amountSol,
        maxSlippageBps: proposal.proposal.expectedSlippageBps,
        maxPriceImpactBps: proposal.proposal.expectedPriceImpactBps,
        quoteFetchedAt: proposal.proposal.quoteFetchedAt,
      });

      // Stage 7: persist
      const stored: StoredExecution = {
        id: randomUUID(),
        proposalId: proposal.id,
        tradeRequestId: proposal.tradeRequestId,
        txSignature: outcome.txSignature || null,
        status: outcome.status,
        error: outcome.error,
        executedAt: Date.now(),
      };

      // Duplicate signature guard (Rule 24)
      if (outcome.txSignature) {
        const clash = await this.deps.executions.getBySignature(outcome.txSignature);
        if (clash) {
          logger.error(
            { event: 'DUPLICATE_SIGNATURE', tradeRequestId: proposal.tradeRequestId, txSignature: outcome.txSignature },
            'Duplicate tx signature — refusing to persist',
          );
          // Keep the lock: this submission reached the network and produced a signature.
          return { kind: 'FAILED', reason: 'DUPLICATE_TX_SIGNATURE' };
        }
      }

      await this.deps.executions.save(stored);

      if (outcome.status === 'CONFIRMED') {
        await this.deps.proposals.updateStatus(proposal.id, 'EXECUTED');
        await this.bookConfirmedFill(proposal, outcome);
        logger.info(
          { event: 'EXECUTION_CONFIRMED', tradeRequestId: proposal.tradeRequestId, txSignature: outcome.txSignature, provider: this.deps.provider.name },
          'Execution confirmed',
        );
        return { kind: 'CONFIRMED', execution: stored };
      }

      if (outcome.status === 'SUBMITTED') {
        await this.deps.proposals.updateStatus(proposal.id, 'SUBMITTED');
        logger.info(
          { event: 'EXECUTION_SUBMITTED', tradeRequestId: proposal.tradeRequestId, txSignature: outcome.txSignature },
          'Execution submitted — awaiting confirmation (reconcile later)',
        );
        return { kind: 'SUBMITTED', execution: stored };
      }

      if (outcome.status === 'UNKNOWN') {
        await this.deps.proposals.updateStatus(proposal.id, 'UNKNOWN');
        logger.error(
          { event: 'EXECUTION_UNKNOWN', tradeRequestId: proposal.tradeRequestId, error: outcome.error },
          'Execution state UNKNOWN — lock retained, manual reconciliation required',
        );
        return { kind: 'UNKNOWN', execution: stored };
      }

      // FAILED: provider is confident the tx did not land.
      await this.deps.proposals.updateStatus(proposal.id, 'FAILED');
      logger.error(
        { event: 'EXECUTION_FAILED', tradeRequestId: proposal.tradeRequestId, error: outcome.error },
        'Execution failed at provider',
      );
      // Keep the lock — a tx with this signature could still exist.
      return { kind: 'FAILED', reason: outcome.error ?? 'PROVIDER_FAILED' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'UNKNOWN';

      if (!submitStarted) {
        // Pre-submit exception: safe to release the lock.
        await this.deps.idempotency.release(this.execKey(proposal.tradeRequestId));
        logger.error({ event: 'EXECUTION_ERROR_PRE_SUBMIT', tradeRequestId: proposal.tradeRequestId, err }, 'Pre-submit error');
        return { kind: 'FAILED', reason };
      }

      // Post-submit exception: NEVER release. Record as UNKNOWN for reconciliation.
      logger.error(
        { event: 'EXECUTION_ERROR_POST_SUBMIT', tradeRequestId: proposal.tradeRequestId, err },
        'Post-submit error — recording as UNKNOWN',
      );
      const unknownStored: StoredExecution = {
        id: randomUUID(),
        proposalId: proposal.id,
        tradeRequestId: proposal.tradeRequestId,
        txSignature: null,
        status: 'UNKNOWN',
        error: reason,
        executedAt: Date.now(),
      };
      try {
        await this.deps.executions.save(unknownStored);
        await this.deps.proposals.updateStatus(proposal.id, 'UNKNOWN');
      } catch (saveErr) {
        logger.error(
          { event: 'UNKNOWN_PERSIST_FAILED', tradeRequestId: proposal.tradeRequestId, saveErr },
          'Failed to persist UNKNOWN execution — this is severe, manual reconciliation needed',
        );
      }
      return { kind: 'UNKNOWN', execution: unknownStored };
    }
  }

  private async bookConfirmedFill(
    proposal: StoredProposal,
    outcome: { filledAmountSol: number; txSignature: string },
  ): Promise<void> {
    try {
      if (proposal.proposal.side === 'BUY') {
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
            { event: 'PNL_RECORDED', tradeRequestId: proposal.tradeRequestId, realizedSol: closeResult.realizedPnlSol },
            'Realized PnL recorded',
          );
        } else {
          logger.warn(
            { event: 'SELL_WITHOUT_POSITION', tradeRequestId: proposal.tradeRequestId },
            'Sell filled but no position was on record',
          );
        }
      }
    } catch (err) {
      logger.error(
        { event: 'LEDGER_RECONCILE_FAILED', tradeRequestId: proposal.tradeRequestId, err },
        'Failed to reconcile position/PnL — gate will be stale until corrected',
      );
    }
  }
}
