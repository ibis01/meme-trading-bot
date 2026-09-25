import { StoredExecution } from '../state/executions';

/**
 * Rule 11: any execution that ends in SUBMITTED or UNKNOWN must eventually be
 * resolved. The reconciler looks up the transaction on-chain and updates the
 * stored record.
 *
 * P1-7 will implement this for live mode. For now the interface exists so
 * the executor can log UNKNOWN events against a known contract rather than
 * a silent gap.
 */
export type ReconciledStatus = 'CONFIRMED' | 'FAILED' | 'STILL_UNKNOWN';

export interface ReconciliationResult {
  status: ReconciledStatus;
  /** Populated when status === 'CONFIRMED'. */
  filledAmountSol?: number;
  filledPriceUsd?: number;
  error?: string;
}

export interface Reconciler {
  readonly name: string;
  /**
   * Look up the on-chain state of an execution that was left in SUBMITTED
   * or UNKNOWN. Must never resubmit — only reconcile.
   */
  reconcile(execution: StoredExecution): Promise<ReconciliationResult>;
}

/** No-op reconciler used in paper mode. */
export class NullReconciler implements Reconciler {
  readonly name = 'null';
  async reconcile(): Promise<ReconciliationResult> {
    return { status: 'STILL_UNKNOWN' };
  }
}
