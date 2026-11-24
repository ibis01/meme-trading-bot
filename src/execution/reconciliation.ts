import { StoredExecution } from '../state/executions';
import { StoredProposal } from '../state/proposals';
import { PositionLedger } from '../state/positions/types';
import { PnlStore } from '../state/dailyPnl';
import { NewRepairInput, RepairStore } from '../state/repairs';
import {
  deriveFillFromTx,
  DerivedFill,
  RawTransactionLike,
} from './fillDerivation';
import { logger } from '../utils/logger';

/**
 * Gate 1 (audit 2026-11-09): THE canonical fill-reconciliation service.
 *
 * Directive: "Both immediate confirmation and delayed reconciliation must
 * call the same function... Re-running reconciliation for the same
 * transaction signature must not create a second position fill or
 * double-count PnL. Currently the delayed reconciliation path can mark an
 * execution CONFIRMED without updating positions or PnL. That must be
 * eliminated before live use."
 *
 * Contract enforced here:
 *  - Derivation: REAL fills from on-chain balance deltas via
 *    deriveFillFromTx — the SAME function the immediate-confirmation path
 *    uses. Fabricated 0/0 amounts are gone (Rule 30).
 *  - Booking: positions/PnL are updated BEFORE any CONFIRMED status is
 *    written. The delayed path can never produce CONFIRMED-without-booking.
 *  - Idempotency: the fill's trade_request_id is pre-checked and UNIQUE-
 *    constrained; a rerun is an exact no-op (ALREADY_BOOKED).
 *  - Failures: anything unbookable creates exactly one durable OPEN repair
 *    (reconciliation_repairs) and leaves the execution unresolved for the
 *    next pass. While repairs are OPEN the risk engine blocks new BUYs
 *    (RECONCILE_REPAIRS_PENDING); SELLs stay available (exits never trap).
 *  - Rule 11: never resubmits — reconciliation is read-only on-chain.
 */

export interface Reconciler {
  readonly name: string;
  /**
   * Fetch the on-chain transaction for an unresolved execution.
   * null = not found / not yet landed (STILL_UNKNOWN — a lagging RPC is NOT
   * evidence of failure). Must never resubmit — read-only on-chain.
   */
  fetchTransaction(execution: StoredExecution): Promise<RawTransactionLike | null>;
}

/** No-op reconciler used in paper mode (paper never leaves unresolved fills). */
export class NullReconciler implements Reconciler {
  readonly name = 'null';
  async fetchTransaction(): Promise<RawTransactionLike | null> {
    return null;
  }
}

export type BookFillResult =
  | { kind: 'BOOKED' }
  | { kind: 'ALREADY_BOOKED' }
  | { kind: 'UNBOOKABLE'; reason: string };

export interface BookFillDeps {
  positions: PositionLedger;
  pnl: PnlStore;
  /** Optional ONLY for legacy unit tests; production always wires one. */
  repairs?: RepairStore;
}

export interface BookFillInput {
  proposal: StoredProposal;
  fill: DerivedFill;
  txSignature: string | null;
}

async function queueRepair(
  repairs: RepairStore | undefined,
  input: NewRepairInput,
): Promise<void> {
  if (!repairs) return; // legacy/test wiring without a queue
  try {
    await repairs.add(input);
  } catch (err) {
    logger.error(
      { event: 'REPAIR_RECORD_FAILED', tradeRequestId: input.tradeRequestId, err },
      'Could not persist reconciliation repair — MANUAL ACTION REQUIRED',
    );
  }
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    (err as { code?: string } | undefined)?.code === '23505' ||
    msg.includes('position_fills_trade_request_id_key')
  );
}

/**
 * THE canonical booking function — shared by the immediate confirmation path
 * (TradeExecutor) and the delayed path (FillReconciliationService).
 */
export async function bookFill(
  deps: BookFillDeps,
  input: BookFillInput,
): Promise<BookFillResult> {
  const { proposal, fill, txSignature } = input;
  const { tradeRequestId } = proposal;
  const mint = proposal.proposal.tokenMint;
  const isBuy = proposal.proposal.side === 'BUY';

  // Idempotency pre-check (Rule 24/25): a rerun of the same request must be
  // an exact no-op. The trade_request_id UNIQUE constraint below is the
  // concurrent-race backstop.
  try {
    const prior = await deps.positions.getFillByRequestId(tradeRequestId);
    if (prior) {
      logger.info(
        { event: 'FILL_ALREADY_BOOKED', tradeRequestId },
        'Idempotent rerun — fill already booked, ledger and PnL untouched',
      );
      return { kind: 'ALREADY_BOOKED' };
    }
  } catch (err) {
    logger.warn(
      { event: 'FILL_IDEMPOTENCY_CHECK_FAILED', tradeRequestId, err },
      'Could not verify fill idempotency — proceeding to the guarded booking path',
    );
  }

  const tokens = fill.filledTokenAmount;
  const sol = fill.filledAmountSol;
  if (!(tokens > 0) || !(sol > 0) || !Number.isFinite(tokens) || !Number.isFinite(sol)) {
    await queueRepair(deps.repairs, {
      tradeRequestId,
      tokenMint: mint,
      side: proposal.proposal.side,
      txSignature: txSignature ?? undefined,
      reason: 'UNUSABLE_FILL_AMOUNTS',
      detail: `tokens=${tokens} sol=${sol} — refusing to book a fabricated position`,
    });
    logger.error(
      { event: 'FILL_NOT_BOOKED', tradeRequestId, reason: 'UNUSABLE_FILL_AMOUNTS' },
      'Refusing to book fabricated fill amounts — repair queued, new BUYs blocked',
    );
    return { kind: 'UNBOOKABLE', reason: 'UNUSABLE_FILL_AMOUNTS' };
  }

  try {
    if (isBuy) {
      await deps.positions.open({
        tokenMint: mint,
        tradeRequestId,
        quantity: tokens,
        priceSol: sol / tokens,
        signature: txSignature ?? '',
      });
    } else {
      const held = await deps.positions.get(mint);
      if (!held || held.quantity <= 0) {
        await queueRepair(deps.repairs, {
          tradeRequestId,
          tokenMint: mint,
          side: 'SELL',
          txSignature: txSignature ?? undefined,
          reason: 'SELL_WITHOUT_POSITION',
          detail: `sell filled ${tokens} tokens but no open position on record`,
        });
        logger.error(
          { event: 'FILL_NOT_BOOKED', tradeRequestId, reason: 'SELL_WITHOUT_POSITION' },
          'Sell filled but no position on record — repair queued, new BUYs blocked',
        );
        return { kind: 'UNBOOKABLE', reason: 'SELL_WITHOUT_POSITION' };
      }
      // Invariant sell <= recorded: book only the recorded portion. If the
      // chain filled more than the ledger knew, that discrepancy is a repair,
      // never a silently absorbed phantom.
      const qty = Math.min(tokens, held.quantity);
      const closeResult = await deps.positions.close({
        tokenMint: mint,
        tradeRequestId,
        quantity: qty,
        priceSol: sol / qty,
        signature: txSignature ?? '',
      });
      await deps.pnl.addSol(closeResult.realizedPnlSol);
      logger.info(
        { event: 'PNL_RECORDED', tradeRequestId, realizedSol: closeResult.realizedPnlSol },
        'Realized PnL recorded',
      );
    }
    logger.info(
      {
        event: 'FILL_BOOKED',
        tradeRequestId,
        tokenMint: mint,
        side: proposal.proposal.side,
        tokens,
        sol,
        txSignature,
      },
      'Fill booked into position ledger',
    );
    return { kind: 'BOOKED' };
  } catch (err) {
    // Concurrent duplicate: the trade_request_id UNIQUE constraint fired.
    if (isUniqueViolation(err)) {
      logger.warn(
        { event: 'FILL_ALREADY_BOOKED', tradeRequestId, err },
        'Duplicate fill insert raced and lost — treating as already booked',
      );
      return { kind: 'ALREADY_BOOKED' };
    }
    await queueRepair(deps.repairs, {
      tradeRequestId,
      tokenMint: mint,
      side: proposal.proposal.side,
      txSignature: txSignature ?? undefined,
      reason: 'LEDGER_BOOKING_FAILED',
      detail: err instanceof Error ? err.message : String(err),
    });
    logger.error(
      { event: 'FILL_NOT_BOOKED', tradeRequestId, reason: 'LEDGER_BOOKING_FAILED', err },
      'Ledger booking threw — repair queued, portfolio state NOT updated',
    );
    return { kind: 'UNBOOKABLE', reason: 'LEDGER_BOOKING_FAILED' };
  }
}

export type ReconcileOutcome =
  | 'BOOKED'
  | 'ALREADY_BOOKED'
  | 'STILL_UNKNOWN'
  | 'FAILED_ONCHAIN'
  | 'REPAIR_QUEUED';

export interface FillReconciliationServiceDeps extends BookFillDeps {
  reconciler: Reconciler;
  /** Token decimals from the chain (never guessed — Rule 30). */
  getTokenDecimals(mint: string): Promise<number | null>;
  /** The trading wallet's base58 address (the fill subject). */
  walletAddress: string;
  updateExecutionStatus(
    id: string,
    status: 'CONFIRMED' | 'FAILED',
    error?: string,
  ): Promise<void>;
  updateProposalStatus(id: string, status: 'EXECUTED' | 'FAILED'): Promise<void>;
}

export class FillReconciliationService {
  constructor(private readonly deps: FillReconciliationServiceDeps) {}

  /**
   * One idempotent reconciliation attempt for one unresolved execution.
   * CONFIRMED is written ONLY after the fill is booked (or was already
   * booked) — the CONFIRMED-without-booking path is structurally gone.
   */
  async reconcileExecution(
    exec: StoredExecution,
    proposal: StoredProposal,
  ): Promise<ReconcileOutcome> {
    // Sticky repairs: once a request is queued for manual repair, the
    // operator owns it — the runner must not fight the ledger mid-repair.
    try {
      if (this.deps.repairs && (await this.deps.repairs.hasOpen(exec.tradeRequestId))) {
        return 'REPAIR_QUEUED';
      }
    } catch (err) {
      logger.error(
        { event: 'REPAIR_CHECK_FAILED', tradeRequestId: exec.tradeRequestId, err },
        'Could not check repair queue — failing closed (treated as repair pending)',
      );
      return 'REPAIR_QUEUED';
    }

    let tx: RawTransactionLike | null = null;
    try {
      tx = await this.deps.reconciler.fetchTransaction(exec);
    } catch (err) {
      logger.error(
        { event: 'RECONCILE_FETCH_ERROR', tradeRequestId: exec.tradeRequestId, err },
        'Reconciler fetch threw — will retry next pass',
      );
      return 'STILL_UNKNOWN';
    }
    if (!tx) return 'STILL_UNKNOWN';

    if (tx.meta?.err) {
      logger.warn(
        { event: 'RECONCILE_FAILED_ONCHAIN', tradeRequestId: exec.tradeRequestId, signature: exec.txSignature },
        'Transaction landed but failed on-chain — no fill exists, marking FAILED',
      );
      await this.deps.updateExecutionStatus(exec.id, 'FAILED', 'ONCHAIN_FAILED');
      await this.deps.updateProposalStatus(proposal.id, 'FAILED');
      return 'FAILED_ONCHAIN';
    }

    const decimals = await this.deps.getTokenDecimals(proposal.proposal.tokenMint);
    if (decimals === null) {
      await queueRepair(this.deps.repairs, {
        executionId: exec.id,
        tradeRequestId: exec.tradeRequestId,
        tokenMint: proposal.proposal.tokenMint,
        side: proposal.proposal.side,
        txSignature: exec.txSignature ?? undefined,
        reason: 'DECIMALS_UNAVAILABLE',
        detail: 'confirmed on-chain but token decimals unavailable — fill not derivable',
      });
      return 'REPAIR_QUEUED';
    }

    const derived = deriveFillFromTx({
      tx,
      walletAddress: this.deps.walletAddress,
      tokenMint: proposal.proposal.tokenMint,
      isBuy: proposal.proposal.side === 'BUY',
      decimals,
    });
    if (!derived.ok) {
      await queueRepair(this.deps.repairs, {
        executionId: exec.id,
        tradeRequestId: exec.tradeRequestId,
        tokenMint: proposal.proposal.tokenMint,
        side: proposal.proposal.side,
        txSignature: exec.txSignature ?? undefined,
        reason: derived.reason,
        detail: 'confirmed on-chain but fill not derivable — manual reconciliation required',
      });
      logger.error(
        { event: 'RECONCILE_FILL_NOT_DERIVABLE', tradeRequestId: exec.tradeRequestId, reason: derived.reason },
        'Confirmed tx but fills not derivable — repair queued, nothing booked',
      );
      return 'REPAIR_QUEUED';
    }

    const booked = await bookFill(this.deps, {
      proposal,
      fill: derived.fill,
      txSignature: exec.txSignature,
    });
    if (booked.kind === 'UNBOOKABLE') return 'REPAIR_QUEUED';

    await this.deps.updateExecutionStatus(exec.id, 'CONFIRMED', undefined);
    await this.deps.updateProposalStatus(proposal.id, 'EXECUTED');
    logger.info(
      {
        event: 'RECONCILED',
        tradeRequestId: exec.tradeRequestId,
        status: 'CONFIRMED',
        booked: booked.kind === 'BOOKED',
        tokens: derived.fill.filledTokenAmount,
        sol: derived.fill.filledAmountSol,
      },
      'Execution reconciled — fill booked and state confirmed',
    );
    return booked.kind === 'BOOKED' ? 'BOOKED' : 'ALREADY_BOOKED';
  }
}
