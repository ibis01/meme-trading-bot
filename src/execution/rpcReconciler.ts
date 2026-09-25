import { SolanaRpcClient } from '../data/solanaRpc';
import { StoredExecution } from '../state/executions';
import { Reconciler, ReconciliationResult } from './reconciliation';
import { logger } from '../utils/logger';

/**
 * P1-7: resolves SUBMITTED and UNKNOWN executions by querying the chain.
 * Rule 30: never assumes an outcome. If the RPC says "not found" it returns
 * STILL_UNKNOWN, not FAILED — a lagging RPC can miss a tx that landed.
 */
export class RpcReconciler implements Reconciler {
  readonly name = 'rpc';

  constructor(private readonly rpc: SolanaRpcClient) {}

  async reconcile(execution: StoredExecution): Promise<ReconciliationResult> {
    if (!execution.txSignature) {
      return { status: 'STILL_UNKNOWN', error: 'NO_SIGNATURE' };
    }

    const tx = await this.rpc.getTransaction(execution.txSignature, {
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 1,
    });

    if (!tx) {
      // RPC returns null both for "not found" and "not yet confirmed".
      // Either way we cannot resolve — stay UNKNOWN.
      return { status: 'STILL_UNKNOWN' };
    }

    const result = tx as {
      meta?: { err?: unknown };
    };

    if (result.meta?.err) {
      logger.warn(
        { event: 'RECONCILE_FAILED_ONCHAIN', signature: execution.txSignature, err: result.meta.err },
        'Transaction landed but failed on-chain',
      );
      return { status: 'FAILED', error: 'ONCHAIN_FAILED' };
    }

    // Confirmed. Fill amount/price are not derivable from raw tx alone —
    // the caller (Postgres ledger) will reconcile those from the token balance delta.
    return {
      status: 'CONFIRMED',
      filledAmountSol: 0,
      filledPriceUsd: 0,
    };
  }
}
