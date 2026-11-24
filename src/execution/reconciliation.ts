import { StoredExecution } from '../state/executions';

/**
 * Rule 11: any execution that ends in SUBMITTED or UNKNOWN must eventually be
 * resolved. The reconciler looks up the transaction on-chain and updates the
 * stored record.
 *
 * Gate 1a: reconciliation NEVER books fills itself. It derives real fill
 * amounts on-chain (deriveFillFromTransaction — shared with the immediate
 * confirm path) and the CALLER books through the canonical FillBookkeeper,
 * so immediate and delayed paths call the same booking function.
 */
export type ReconciledStatus = 'CONFIRMED' | 'FAILED' | 'STILL_UNKNOWN';

export interface ReconciliationResult {
  status: ReconciledStatus;
  /** Populated when status === 'CONFIRMED'. REQUIRED derivable fills. */
  filledAmountSol?: number;
  filledTokenAmount?: number;
  /** EXACT raw base units when derivable (Gate 2). */
  filledTokenAmountRaw?: string;
  filledPriceUsd?: number;
  error?: string;
}

/** Mint/side of the trade behind an execution, resolved by the runner. */
export interface ReconciliationContext {
  tokenMint: string;
  side: 'BUY' | 'SELL';
}

export interface Reconciler {
  readonly name: string;
  /**
   * Look up the on-chain state of an execution that was left in SUBMITTED
   * or UNKNOWN. Must never resubmit — only reconcile. `context` is the
   * proposal-derived trade metadata needed to derive fills; null when the
   * proposal is missing (the reconciler then refuses to CONFIRM).
   */
  reconcile(
    execution: StoredExecution,
    context: ReconciliationContext | null,
  ): Promise<ReconciliationResult>;
}

/** No-op reconciler used in paper mode. */
export class NullReconciler implements Reconciler {
  readonly name = 'null';
  async reconcile(): Promise<ReconciliationResult> {
    return { status: 'STILL_UNKNOWN' };
  }
}
