import { StoredExecution } from '../state/executions';
import { StoredProposal } from '../state/proposals';

/**
 * Rule 11: any execution that ends in SUBMITTED or UNKNOWN must eventually be
 * resolved. The reconciler looks up the transaction on-chain and derives the
 * REAL fill amounts through the canonical derivation
 * (src/execution/fillDerivation.ts) — the same function the immediate path
 * uses (audit C1: no divergent derivation, no fabricated zero fills).
 *
 * Must never resubmit — reconciliation is read-only on-chain.
 */
export type ReconciledStatus = 'CONFIRMED' | 'FAILED' | 'STILL_UNKNOWN';

export interface ReconciliationResult {
  status: ReconciledStatus;
  /** Populated when status === 'CONFIRMED'. Real amounts, never zeros. */
  filledAmountSol?: number;
  filledTokenAmount?: number;
  error?: string;
}

export interface Reconciler {
  readonly name: string;
  /**
   * Look up the on-chain state of an execution that was left in SUBMITTED
   * or UNKNOWN (or a CONFIRMED execution whose fill was never booked).
   * The proposal (side / token mint) is required for fill derivation.
   */
  reconcile(execution: StoredExecution, proposal: StoredProposal | null): Promise<ReconciliationResult>;
}

/** No-op reconciler used in paper mode. */
export class NullReconciler implements Reconciler {
  readonly name = 'null';
  async reconcile(): Promise<ReconciliationResult> {
    return { status: 'STILL_UNKNOWN' };
  }
}
