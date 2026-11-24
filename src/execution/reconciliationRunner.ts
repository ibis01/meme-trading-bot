import { ExecutionStore, StoredExecution } from '../state/executions';
import { ProposalStore } from '../state/proposals';
import { Reconciler } from './reconciliation';
import { FillBookkeeper, FillBookingInput } from './fillBookkeeper';
import { logger } from '../utils/logger';

export interface RunnerResult {
  scanned: number;
  resolved: number;
  stillUnknown: number;
  errors: number;
  /** CONFIRMED executions booked into positions/PnL this pass. */
  booked: number;
  /** Booking attempts that failed — the rows stay in the repair queue. */
  bookingFailures: number;
}

/**
 * P1-7 / Gate 1a: scans for unresolved executions and reconciles each one,
 * then books confirmed fills through THE canonical FillBookkeeper (the same
 * function the immediate confirm path uses).
 *
 * Invariants:
 *  - An execution is NEVER marked CONFIRMED without its fill being booked
 *    (or without knowing booking is impossible — then it stays unresolved).
 *  - Re-running the runner for the same signature is idempotent: the
 *    bookkeeper's claim makes the second pass a no-op — no duplicate
 *    position fill, no double-counted PnL.
 *  - Booking failures leave the execution CONFIRMED-but-unbooked: the
 *    persistent repair queue. countUnresolved() includes those rows, so
 *    new BUYs stay blocked until the queue drains.
 *  - Rule 23: errors are logged, never swallowed; a single bad execution
 *    does not abort the batch. Rule 11: never resubmits.
 */
export class ReconciliationRunner {
  constructor(
    private readonly executions: ExecutionStore,
    private readonly proposals: ProposalStore,
    private readonly reconciler: Reconciler,
    private readonly bookkeeper: FillBookkeeper,
  ) {}

  async runOnce(limit: number = 50): Promise<RunnerResult> {
    const result: RunnerResult = {
      scanned: 0,
      resolved: 0,
      stillUnknown: 0,
      errors: 0,
      booked: 0,
      bookingFailures: 0,
    };

    // Pass 1: repair-queue sweep — CONFIRMED-but-unbooked rows. These are
    // already final on-chain; they just need their fill booked (or, when
    // fills were never derivable, a fresh derivation attempt).
    const pendingBookings = await this.executions.listPendingBookings(limit);
    for (const exec of pendingBookings) {
      result.scanned += 1;
      await this.resolveOne(exec, result, { alreadyConfirmed: true });
    }

    // Pass 2: unresolved outcomes — SUBMITTED/UNKNOWN.
    const pending = await this.executions.listUnresolved(limit);
    for (const exec of pending) {
      result.scanned += 1;
      await this.resolveOne(exec, result, { alreadyConfirmed: false });
    }

    return result;
  }

  private async resolveOne(
    exec: StoredExecution,
    result: RunnerResult,
    opts: { alreadyConfirmed: boolean },
  ): Promise<void> {
    try {
      const proposal = await this.proposals.getById(exec.proposalId);
      const context = proposal
        ? { tokenMint: proposal.proposal.tokenMint, side: proposal.proposal.side }
        : null;

      const r = await this.reconciler.reconcile(exec, context);

      if (r.status === 'STILL_UNKNOWN') {
        result.stillUnknown += 1;
        if (opts.alreadyConfirmed && r.error) {
          logger.warn(
            { event: 'RECONCILE_REPAIR_UNRESOLVED', tradeRequestId: exec.tradeRequestId, error: r.error },
            'Booked-pending execution could not be re-resolved — stays in repair queue',
          );
        }
        return;
      }

      if (r.status === 'FAILED') {
        await this.executions.updateStatus(exec.id, 'FAILED', r.error);
        await this.proposals.updateStatus(exec.proposalId, 'FAILED');
        result.resolved += 1;
        logger.info(
          { event: 'RECONCILED', tradeRequestId: exec.tradeRequestId, status: 'FAILED' },
          'Execution reconciled',
        );
        return;
      }

      // CONFIRMED — but without derivable fills we do NOT accept it.
      // Marking CONFIRMED without booking positions/PnL is exactly the bug
      // this gate eliminates.
      const usable =
        typeof r.filledAmountSol === 'number' &&
        r.filledAmountSol > 0 &&
        typeof r.filledTokenAmount === 'number' &&
        r.filledTokenAmount > 0;
      if (!usable) {
        result.stillUnknown += 1;
        if (!opts.alreadyConfirmed) {
          await this.executions.updateStatus(
            exec.id,
            'UNKNOWN',
            'FILL_AMOUNTS_UNAVAILABLE',
          );
        }
        logger.error(
          { event: 'RECONCILE_FILL_UNAVAILABLE', tradeRequestId: exec.tradeRequestId, error: r.error },
          'Confirmed on-chain but fills not derivable — kept unresolved, no fabricated booking',
        );
        return;
      }

      const booking: FillBookingInput = {
        executionId: exec.id,
        proposalId: exec.proposalId,
        tradeRequestId: exec.tradeRequestId,
        tokenMint: context!.tokenMint,
        side: context!.side,
        filledAmountSol: r.filledAmountSol!,
        filledTokenAmount: r.filledTokenAmount!,
        filledTokenAmountRaw: r.filledTokenAmountRaw,
        txSignature: exec.txSignature,
        executedAt: exec.executedAt,
      };

      const applied = await this.bookkeeper.applyConfirmedFill(booking);
      // Store-level status finalization (the Postgres bookkeeper already did
      // this inside its transaction; the in-memory bookkeeper does not own
      // the stores). Both values are idempotent.
      await this.executions.updateStatus(exec.id, 'CONFIRMED', r.error);
      await this.proposals.updateStatus(exec.proposalId, 'EXECUTED');
      result.resolved += 1;
      if (applied.alreadyBooked) {
        logger.info(
          { event: 'RECONCILE_BOOKING_IDEMPOTENT_SKIP', tradeRequestId: exec.tradeRequestId },
          'Fill already booked — idempotent re-run, nothing double-counted',
        );
        return;
      }
      result.booked += 1;
      logger.info(
        {
          event: 'RECONCILE_BOOKED',
          tradeRequestId: exec.tradeRequestId,
          signature: exec.txSignature,
          side: booking.side,
          filledAmountSol: booking.filledAmountSol,
        },
        'Reconciled execution booked into positions/PnL via canonical bookkeeper',
      );
    } catch (err) {
      if (String(err instanceof Error ? err.message : err).startsWith('BOOKING_')) {
        result.bookingFailures += 1;
        result.errors += 1;
        logger.error(
          { event: 'REPAIR_QUEUE_BOOKING_FAILED', tradeRequestId: exec.tradeRequestId, err },
          'Booking failed — execution stays in the persistent repair queue; new BUYs blocked',
        );
        return;
      }
      result.errors += 1;
      logger.error(
        { event: 'RECONCILE_ERROR', tradeRequestId: exec.tradeRequestId, err },
        'Reconciliation threw',
      );
    }
  }
}
