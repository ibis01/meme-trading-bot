import { SolanaRpcClient } from '../data/solanaRpc';
import { StoredExecution } from '../state/executions';
import { StoredProposal } from '../state/proposals';
import {
  Reconciler,
  ReconciliationResult,
} from './reconciliation';
import { deriveFillFromTransaction, DerivableTransaction } from './fillDerivation';
import { logger } from '../utils/logger';

/**
 * P1-7, hardened by audit C1 (2026-11-24): resolves SUBMITTED and UNKNOWN
 * executions by querying the chain and deriving REAL fills from balance
 * deltas through the canonical derivation shared with the live pipeline.
 *
 * Rule 30: never assumes an outcome. If the RPC says "not found" it returns
 * STILL_UNKNOWN, not FAILED — a lagging RPC can miss a tx that landed.
 * If the tx landed but any evidence for fill amounts is missing, the result
 * is STILL_UNKNOWN (audit: never CONFIRMED with fabricated zero amounts).
 */
export class RpcReconciler implements Reconciler {
  readonly name = 'rpc';

  constructor(
    private readonly rpc: SolanaRpcClient,
    /** The trading wallet's public address (fills are derived for THIS wallet). */
    private readonly walletAddress: string,
  ) {}

  async reconcile(
    execution: StoredExecution,
    proposal: StoredProposal | null,
  ): Promise<ReconciliationResult> {
    if (!execution.txSignature) {
      return { status: 'STILL_UNKNOWN', error: 'NO_SIGNATURE' };
    }
    if (!proposal) {
      // Without the proposal we do not know side or mint — no derivation.
      return { status: 'STILL_UNKNOWN', error: 'PROPOSAL_MISSING' };
    }

    const tx = (await this.rpc.getTransaction(execution.txSignature, {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 1,
    })) as DerivableTransaction | null;

    if (!tx) {
      // RPC returns null both for "not found" and "not yet confirmed".
      // Either way we cannot resolve — stay UNKNOWN.
      return { status: 'STILL_UNKNOWN' };
    }

    if (tx.meta?.err) {
      logger.warn(
        { event: 'RECONCILE_FAILED_ONCHAIN', signature: execution.txSignature, err: tx.meta.err },
        'Transaction landed but failed on-chain',
      );
      return { status: 'FAILED', error: 'ONCHAIN_FAILED' };
    }

    const isBuy = proposal.proposal.side === 'BUY';
    const decimals = await this.getTokenDecimals(proposal.proposal.tokenMint);
    if (decimals === null) {
      return { status: 'STILL_UNKNOWN', error: 'VERIFY_DECIMALS_UNAVAILABLE' };
    }

    const derived = deriveFillFromTransaction(tx, {
      walletAddress: this.walletAddress,
      tokenMint: proposal.proposal.tokenMint,
      isBuy,
      decimals,
    });

    if (!derived.ok) {
      // Confirmed-but-unprovable: stay UNKNOWN with the derivation reason.
      // (Audit C1: the old code returned CONFIRMED with zeros here.)
      logger.warn(
        { event: 'RECONCILE_FILL_UNPROVABLE', signature: execution.txSignature, reason: derived.reason },
        'Transaction landed but fill amounts cannot be derived — staying unresolved',
      );
      return { status: 'STILL_UNKNOWN', error: derived.reason };
    }

    return {
      status: 'CONFIRMED',
      filledAmountSol: derived.filledAmountSol,
      filledTokenAmount: derived.filledTokenAmount,
    };
  }

  private async getTokenDecimals(mint: string): Promise<number | null> {
    const supply = await this.rpc.getTokenSupply(mint);
    if (!supply || !Number.isInteger(supply.decimals)) return null;
    return supply.decimals;
  }
}
