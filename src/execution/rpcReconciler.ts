import { SolanaRpcClient } from '../data/solanaRpc';
import { StoredExecution } from '../state/executions';
import { Reconciler, ReconciliationResult, ReconciliationContext } from './reconciliation';
import { deriveFillFromTransaction, DerivableTransaction } from './fillDerivation';
import { logger } from '../utils/logger';

/**
 * P1-7 / Gate 1a: resolves SUBMITTED and UNKNOWN executions by querying the
 * chain. Rule 30: never assumes an outcome. If the RPC says "not found" it
 * returns STILL_UNKNOWN, not FAILED — a lagging RPC can miss a tx that
 * landed.
 *
 * Gate 1a contract: a CONFIRMED result ALWAYS carries real fill amounts
 * derived by deriveFillFromTransaction() — the same function the immediate
 * confirm path uses. The reconciler NEVER returns CONFIRMED with zero/absent
 * fills: without derivable amounts it stays unresolved (STILL_UNKNOWN) so
 * the execution can never be marked CONFIRMED without positions/PnL being
 * updated. Booking itself is done by the canonical FillBookkeeper.
 */
export class RpcReconciler implements Reconciler {
  readonly name = 'rpc';

  constructor(
    private readonly rpc: SolanaRpcClient,
    /**
     * The wallet whose balance deltas define the fill. Required for fill
     * derivation; without it the reconciler cannot resolve CONFIRMED fills
     * and refuses honestly (STILL_UNKNOWN) instead of fabricating zeros.
     */
    private readonly walletAddress?: string,
  ) {}

  async reconcile(
    execution: StoredExecution,
    context: ReconciliationContext | null,
  ): Promise<ReconciliationResult> {
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

    if ((tx as { meta?: { err?: unknown } }).meta?.err) {
      logger.warn(
        { event: 'RECONCILE_FAILED_ONCHAIN', signature: execution.txSignature, err: (tx as { meta?: { err?: unknown } }).meta?.err },
        'Transaction landed but failed on-chain',
      );
      return { status: 'FAILED', error: 'ONCHAIN_FAILED' };
    }

    // Confirmed on-chain. Without the trade context (mint/side) or the
    // wallet address we cannot derive fills — refusing to return a bare
    // CONFIRMED is the fix for "marked CONFIRMED without updating
    // positions or PnL".
    if (!context) {
      return { status: 'STILL_UNKNOWN', error: 'RECONCILE_NO_CONTEXT' };
    }
    if (!this.walletAddress) {
      return { status: 'STILL_UNKNOWN', error: 'RECONCILE_NO_WALLET' };
    }

    const decimals = await this.rpc.getTokenSupply(context.tokenMint);
    if (!decimals || !Number.isInteger(decimals.decimals)) {
      return { status: 'STILL_UNKNOWN', error: 'RECONCILE_DECIMALS_UNAVAILABLE' };
    }

    const derived = deriveFillFromTransaction(tx as DerivableTransaction, {
      walletAddress: this.walletAddress,
      tokenMint: context.tokenMint,
      isBuy: context.side === 'BUY',
      decimals: decimals.decimals,
    });
    if (!derived.ok) {
      return { status: 'STILL_UNKNOWN', error: derived.error };
    }

    return {
      status: 'CONFIRMED',
      filledAmountSol: derived.amountSol,
      filledTokenAmount: derived.tokenAmount,
      filledTokenAmountRaw: derived.tokenAmountRaw,
    };
  }
}
