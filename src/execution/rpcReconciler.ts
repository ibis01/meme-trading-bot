import { SolanaRpcClient } from '../data/solanaRpc';
import { StoredExecution } from '../state/executions';
import { Reconciler } from './reconciliation';
import { RawTransactionLike } from './fillDerivation';

/**
 * Gate 1 (audit 2026-11-09): thin on-chain fetcher for the canonical
 * FillReconciliationService. DEFECT FIXED: this class previously RETURNED a
 * fabricated reconciliation result (`CONFIRMED` with filledAmountSol: 0) —
 * derivation and booking now live in the shared service/derivation modules,
 * so the reconciler only fetches chain state and never invents outcomes
 * (Rule 30).
 */
export class RpcReconciler implements Reconciler {
  readonly name = 'rpc';

  constructor(private readonly rpc: SolanaRpcClient) {}

  async fetchTransaction(
    execution: StoredExecution,
  ): Promise<RawTransactionLike | null> {
    if (!execution.txSignature) return null;
    const tx = await this.rpc.getTransaction(execution.txSignature, {
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 1,
    });
    return (tx as RawTransactionLike | null) ?? null;
  }
}
