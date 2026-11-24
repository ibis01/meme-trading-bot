import { ExecutionStore, StoredExecution } from '../state/executions';
import { ProposalStore } from '../state/proposals';
import {
  FillReconciliationService,
  ReconcileOutcome,
} from './reconciliation';
import { RepairStore } from '../state/repairs';
import { logger } from '../utils/logger';

export interface RunnerResult {
  scanned: number;
  booked: number;
  alreadyBooked: number;
  stillUnknown: number;
  failedOnchain: number;
  repairsQueued: number;
  errors: number;
}

export interface ReconciliationRunnerDeps {
  executions: ExecutionStore;
  proposals: ProposalStore;
  service: FillReconciliationService;
  repairs?: RepairStore;
}

/**
 * Gate 1 (audit 2026-11-09): scans for unresolved executions and runs each
 * through the canonical FillReconciliationService. DEFECT FIXED: this runner
 * previously marked executions CONFIRMED and proposals EXECUTED WITHOUT ever
 * updating positions/PnL (the reconciler even fabricated filledAmountSol: 0).
 *
 * Rule 23: one bad execution does not abort the batch.
 * Rule 11: never resubmits — reconciliation is read-only on-chain.
 */
export class ReconciliationRunner {
  constructor(private readonly deps: ReconciliationRunnerDeps) {}

  async runOnce(limit: number = 50): Promise<RunnerResult> {
    const result: RunnerResult = {
      scanned: 0,
      booked: 0,
      alreadyBooked: 0,
      stillUnknown: 0,
      failedOnchain: 0,
      repairsQueued: 0,
      errors: 0,
    };

    let pending: StoredExecution[];
    try {
      pending = await this.deps.executions.listUnresolved(limit);
    } catch (err) {
      result.errors += 1;
      logger.error(
        { event: 'RECONCILE_LIST_ERROR', err },
        'Could not list unresolved executions — skipping this pass',
      );
      return result;
    }
    result.scanned = pending.length;

    for (const exec of pending) {
      try {
        const proposal = await this.deps.proposals.getByRequestId(exec.tradeRequestId);
        if (!proposal) {
          // No proposal → no mint/side context → fills cannot be derived and
          // the record cannot be closed out. Surface it; do not guess (Rule 30).
          await this.queueRepair(exec, 'PROPOSAL_MISSING', 'No proposal row for an unresolved execution');
          result.repairsQueued += 1;
          continue;
        }
        const outcome: ReconcileOutcome =
          await this.deps.service.reconcileExecution(exec, proposal);
        switch (outcome) {
          case 'BOOKED': result.booked += 1; break;
          case 'ALREADY_BOOKED': result.alreadyBooked += 1; break;
          case 'STILL_UNKNOWN': result.stillUnknown += 1; break;
          case 'FAILED_ONCHAIN': result.failedOnchain += 1; break;
          case 'REPAIR_QUEUED': result.repairsQueued += 1; break;
        }
      } catch (err) {
        result.errors += 1;
        logger.error(
          { event: 'RECONCILE_ERROR', tradeRequestId: exec.tradeRequestId, err },
          'Reconciliation threw',
        );
      }
    }

    return result;
  }

  private async queueRepair(
    exec: StoredExecution,
    reason: string,
    detail: string,
  ): Promise<void> {
    if (!this.deps.repairs) return;
    try {
      await this.deps.repairs.add({
        executionId: exec.id,
        tradeRequestId: exec.tradeRequestId,
        txSignature: exec.txSignature ?? undefined,
        reason,
        detail,
      });
    } catch (err) {
      logger.error(
        { event: 'REPAIR_RECORD_FAILED', tradeRequestId: exec.tradeRequestId, err },
        'Could not persist reconciliation repair — MANUAL ACTION REQUIRED',
      );
    }
  }
}
