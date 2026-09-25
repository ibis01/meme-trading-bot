import { ExecutionStore } from '../state/executions';
import { ProposalStore } from '../state/proposals';
import { Reconciler } from './reconciliation';
import { logger } from '../utils/logger';

export interface RunnerResult {
  scanned: number;
  resolved: number;
  stillUnknown: number;
  errors: number;
}

/**
 * P1-7: scans for unresolved executions and reconciles each one.
 * Rule 23: errors are logged, never swallowed; a single bad execution
 * does not abort the batch.
 * Rule 11: never resubmits — reconciliation is read-only on-chain.
 */
export class ReconciliationRunner {
  constructor(
    private readonly executions: ExecutionStore,
    private readonly proposals: ProposalStore,
    private readonly reconciler: Reconciler,
  ) {}

  async runOnce(limit: number = 50): Promise<RunnerResult> {
    const result: RunnerResult = { scanned: 0, resolved: 0, stillUnknown: 0, errors: 0 };

    const pending = await this.executions.listUnresolved(limit);
    result.scanned = pending.length;

    for (const exec of pending) {
      try {
        const r = await this.reconciler.reconcile(exec);

        if (r.status === 'STILL_UNKNOWN') {
          result.stillUnknown += 1;
          continue;
        }

        await this.executions.updateStatus(exec.id, r.status, r.error);

        if (r.status === 'CONFIRMED') {
          await this.proposals.updateStatus(exec.proposalId, 'EXECUTED');
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

    return result;
  }
}
