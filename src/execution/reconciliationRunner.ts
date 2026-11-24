import { ExecutionStore } from '../state/executions';
import { ProposalStore } from '../state/proposals';
import { Reconciler } from './reconciliation';
import { FillLedger, BookingSource } from './fillLedger';
import { logger } from '../utils/logger';

export interface RunnerResult {
  scanned: number;
  resolved: number;
  stillUnknown: number;
  errors: number;
  /** CONFIRMED results whose fills were booked into positions/PnL. */
  booked: number;
  /** Repair-sweep candidates discovered and re-attempted. */
  repaired: number;
  /** Confirmed fills that violate booking invariants (repair queue). */
  unbookable: number;
}

/**
 * P1-7, hardened by audit C1/C2 (2026-11-24).
 *
 * Two passes per tick:
 *  1. Resolve SUBMITTED/UNKNOWN executions on-chain, derive REAL fills via
 *     the shared derivation, and BOOK them through the canonical FillLedger
 *     (positions + PnL + status commit atomically; re-runs are idempotent).
 *     The pre-audit behavior — marking an execution CONFIRMED without ever
 *     touching positions/PnL — is eliminated.
 *  2. Repair sweep: find CONFIRMED executions whose fill was never booked
 *     (crash between execution-save and booking, DB outage during booking)
 *     and re-attempt booking. The queue blocks new BUYs until drained.
 *
 * Rule 23: one bad execution never aborts the batch.
 * Rule 11: never resubmits — reconciliation is read-only on-chain.
 */
export class ReconciliationRunner {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;
  private stopping = false;

  constructor(
    private readonly executions: ExecutionStore,
    private readonly proposals: ProposalStore,
    private readonly reconciler: Reconciler,
    private readonly fillLedger: FillLedger,
  ) {}

  async runOnce(limit: number = 50): Promise<RunnerResult> {
    const result: RunnerResult = {
      scanned: 0,
      resolved: 0,
      stillUnknown: 0,
      errors: 0,
      booked: 0,
      repaired: 0,
      unbookable: 0,
    };

    await this.resolvePending(result, limit);
    await this.repairUnbooked(result, limit);

    logger.info(
      { event: 'RECONCILIATION_TICK', ...result },
      'Reconciliation pass complete',
    );
    return result;
  }

  private async resolvePending(result: RunnerResult, limit: number): Promise<void> {
    const pending = await this.executions.listUnresolved(limit);
    result.scanned += pending.length;

    for (const exec of pending) {
      if (this.stopping) return;
      try {
        const proposal = await this.proposals.getByRequestId(exec.tradeRequestId);
        const r = await this.reconciler.reconcile(exec, proposal);

        if (r.status === 'STILL_UNKNOWN') {
          result.stillUnknown += 1;
          continue;
        }

        await this.executions.updateStatus(exec.id, r.status, r.error);

        if (r.status === 'CONFIRMED') {
          await this.proposals.updateStatus(exec.proposalId, 'EXECUTED');
          const booked = await this.bookFill(exec, proposal, r, 'RECONCILED');
          if (booked.booked) result.booked += 1;
          if (booked.unbookable) result.unbookable += 1;
        } else {
          await this.proposals.updateStatus(exec.proposalId, 'FAILED');
        }
        result.resolved += 1;
        logger.info(
          { event: 'RECONCILED', tradeRequestId: exec.tradeRequestId, status: r.status },
          'Execution reconciled',
        );
      } catch (err) {
        result.errors += 1;
        logger.error(
          { event: 'RECONCILE_ERROR', tradeRequestId: exec.tradeRequestId, err },
          'Reconciliation threw',
        );
      }
    }
  }

  /**
   * CONFIRMED executions whose fill never reached the ledger: crash between
   * execution-save and booking, or the database died mid-booking. Re-derive
   * the fill on-chain and book through the canonical ledger (idempotent).
   */
  private async repairUnbooked(result: RunnerResult, limit: number): Promise<void> {
    let candidates;
    try {
      candidates = await this.fillLedger.listRepairCandidates(limit);
    } catch (err) {
      result.errors += 1;
      logger.error(
        { event: 'REPAIR_SCAN_ERROR', err },
        'Repair sweep could not list candidates',
      );
      return;
    }

    for (const candidate of candidates) {
      if (this.stopping) return;
      result.repaired += 1;
      try {
        const exec = await this.executions.getByRequestId(candidate.tradeRequestId);
        const proposal = await this.proposals.getByRequestId(candidate.tradeRequestId);
        if (!exec) continue;
        const r = await this.reconciler.reconcile(exec, proposal);

        if (r.status === 'CONFIRMED' && r.filledAmountSol !== undefined) {
          const booked = await this.bookFill(exec, proposal, r, 'RECONCILED');
          if (booked.booked) result.booked += 1;
          if (booked.unbookable) result.unbookable += 1;
        } else if (r.status === 'FAILED') {
          // The chain says the tx failed, but the execution row says
          // CONFIRMED — contradictory evidence must never silently pass.
          await this.fillLedger.markUnbookable(
            exec.id,
            exec.txSignature,
            'RECONCILED',
            `REPAIR_ONCHAIN_CONTRADICTION:${r.error ?? 'ONCHAIN_FAILED'}`,
          );
          result.unbookable += 1;
        } else {
          result.stillUnknown += 1;
        }
      } catch (err) {
        result.errors += 1;
        logger.error(
          { event: 'REPAIR_ERROR', tradeRequestId: candidate.tradeRequestId, err },
          'Repair attempt threw',
        );
      }
    }
  }

  /** Returns booking outcome counts for the caller's tick stats. */
  private async bookFill(
    exec: { id: string; tradeRequestId: string; txSignature: string | null },
    proposal: Awaited<ReturnType<ProposalStore['getByRequestId']>>,
    r: { filledAmountSol?: number; filledTokenAmount?: number },
    source: BookingSource,
  ): Promise<{ booked: boolean; unbookable: boolean }> {
    if (!proposal || !exec.txSignature) {
      await this.fillLedger.markUnbookable(
        exec.id,
        exec.txSignature,
        source,
        !proposal ? 'PROPOSAL_MISSING' : 'NO_SIGNATURE',
      );
      return { booked: false, unbookable: true };
    }
    const outcome = await this.fillLedger.bookFill({
      executionId: exec.id,
      proposalId: proposal.id,
      tradeRequestId: exec.tradeRequestId,
      side: proposal.proposal.side,
      tokenMint: proposal.proposal.tokenMint,
      txSignature: exec.txSignature,
      filledAmountSol: r.filledAmountSol ?? 0,
      filledTokenAmount: r.filledTokenAmount ?? 0,
      source,
    });

    switch (outcome.kind) {
      case 'BOOKED':
        logger.info(
          {
            event: 'FILL_BOOKED',
            tradeRequestId: exec.tradeRequestId,
            txSignature: exec.txSignature,
            source,
            realizedPnlSol: outcome.realizedPnlSol,
          },
          'Fill booked into positions/PnL',
        );
        if (outcome.realizedPnlSol !== undefined) {
          logger.info(
            { event: 'PNL_RECORDED', tradeRequestId: exec.tradeRequestId, realizedSol: outcome.realizedPnlSol },
            'Realized PnL recorded',
          );
        }
        return { booked: true, unbookable: false };
      case 'ALREADY_BOOKED':
        return { booked: true, unbookable: false };
      case 'UNRECONCILABLE':
        // The ledger already recorded UNRECONCILABLE in the repair queue.
        return { booked: false, unbookable: true };
      case 'QUEUED':
        logger.error(
          { event: 'FILL_BOOKING_QUEUED', tradeRequestId: exec.tradeRequestId, error: outcome.error },
          'Fill booking failed transiently — repair queue holds it; new BUYs blocked',
        );
        return { booked: false, unbookable: false };
    }
  }

  /** Background lifecycle so the production loop actually runs this (audit C1). */
  start(intervalMs: number): void {
    if (this.timer) return;
    if (!(intervalMs > 0)) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      if (this.inFlight) {
        logger.warn(
          { event: 'RECONCILIATION_TICK_SKIPPED_OVERLAP' },
          'Previous reconciliation pass still running; skipping',
        );
        return;
      }
      this.inFlight = this.runOnce()
        .catch((err) =>
          logger.error(
            { event: 'RECONCILIATION_TICK_ERROR', err },
            'Reconciliation pass failed',
          ),
        )
        .finally(() => {
          this.inFlight = null;
        });
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info(
      { event: 'RECONCILIATION_RUNNER_STARTED', intervalMs },
      'Reconciliation runner started',
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
    logger.info({ event: 'RECONCILIATION_RUNNER_STOPPED' }, 'Reconciliation runner stopped');
  }
}
