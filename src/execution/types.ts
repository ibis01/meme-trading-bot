/**
 * Rule 11 / Rule 24: execution has FOUR terminal or transient states, not two.
 *
 *   SUBMITTED  — provider handed the tx to the network but hasn't confirmed yet.
 *                Transient. Keep the idempotency lock. Reconcile later.
 *   UNKNOWN    — provider attempted submission but state is ambiguous
 *                (timeout, lost response, RPC error mid-submit).
 *                NEVER release the lock. Reconcile later. NEVER auto-retry.
 *   CONFIRMED  — confirmed on-chain. Book the fill.
 *   FAILED     — provider knows the tx did not land. Keep the lock (a tx with
 *                this signature may still exist on-chain, and a retry would
 *                be a new submission).
 */
export type ExecutionStatus = 'SUBMITTED' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED';

export interface ExecutionRequest {
  tradeRequestId: string;
  tokenMint: string;
  side: 'BUY' | 'SELL';
  amountSol: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  quoteFetchedAt: number;
}

export interface ExecutionOutcome {
  /** Empty string is allowed only for FAILED (pre-submit failures). */
  txSignature: string;
  filledAmountSol: number;
  filledPriceUsd: number;
  status: ExecutionStatus;
  error?: string;
}

export interface ExecutionProvider {
  readonly name: string;
  /** Throw if not safe to run in the current config. */
  assertEnabled(): void;
  execute(req: ExecutionRequest): Promise<ExecutionOutcome>;
}
