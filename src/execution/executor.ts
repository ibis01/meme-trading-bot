import { randomUUID } from 'crypto';
import { RiskEngine } from '../risk/engine';
import { KillSwitchStore } from '../state/killSwitch';
import { PositionLedger } from '../state/positions/types';
import { ProposalStore, StoredProposal } from '../state/proposals';
import { ExecutionStore, StoredExecution } from '../state/executions';
import { PnlStore } from '../state/dailyPnl';
import { IdempotencyService } from '../infra/idempotency';
import { ExecutionProvider } from './types';
import { FillLedger } from './fillLedger';
import { logger } from '../utils/logger';

export interface TradeExecutorDeps {
  riskEngine: RiskEngine;
  killSwitch: KillSwitchStore;
  positions: PositionLedger;
  proposals: ProposalStore;
  executions: ExecutionStore;
  idempotency: IdempotencyService;
  provider: ExecutionProvider;
  pnl: PnlStore;
  /**
   * Audit C1/C2 (2026-11-24): THE canonical fill booking service. Every
   * confirmed fill — immediate or reconciled — books through it (idempotent,
   * transactional) and its health gate blocks new BUYs while any fill is
   * unbooked or uncertain.
   */
  fillLedger: FillLedger;
}

export type ExecuteResult =
  | { kind: 'CONFIRMED'; execution: StoredExecution }
  | { kind: 'SUBMITTED'; execution: StoredExecution }
  | { kind: 'UNKNOWN'; execution: StoredExecution }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'DUPLICATE'; execution: StoredExecution }
  | { kind: 'FAILED'; reason: string };

/**
 * Rule 11: executor honors a four-state submission model.
 * Rule 24: pre-submit failures release the idempotency lock (safe to retry).
 *          post-submit failures NEVER release the lock (retry could double-submit).
 */
export class TradeExecutor {
  constructor(private readonly deps: TradeExecutorDeps) {}

  private execKey(tradeRequestId: string): string {
    return `exec:${tradeRequestId}`;
  }

  async execute(proposal: StoredProposal): Promise<ExecuteResult> {
    // Stage 0: shadow proposals (Phase 1 scaffold) simulate with NO side
    // effects — no idempotency, no stores, no provider. NOTE: this runs
    // before the APPROVED check by design; nothing may set isShadow on a
    // live-trading path until that ordering is explicitly reviewed and
    // covered by tests.
    if (proposal.proposal.isShadow) {
      logger.info(
        {
          event: 'SHADOW_TRADE_SIMULATED',
          tokenMint: proposal.proposal.tokenMint,
          side: proposal.proposal.side,
        },
        'Shadow trade intercepted and logged',
      );
      return {
        kind: 'CONFIRMED',
        execution: {
          id: randomUUID(),
          proposalId: proposal.id,
          tradeRequestId: proposal.tradeRequestId,
          txSignature: 'shadow_sim',
          status: 'CONFIRMED',
          executedAt: Date.now(),
        },
      };
    }

    // Stage 1: VALIDATE (no side effects)
    if (proposal.status !== 'APPROVED') {
      return {
        kind: 'REJECTED',
        reason: `PROPOSAL_NOT_APPROVED:${proposal.status}`,
      };
    }

    // Stage 2: idempotency acquire
    const firstTime = await this.deps.idempotency.acquire(
      this.execKey(proposal.tradeRequestId),
    );
    if (!firstTime) {
      const existing = await this.deps.executions.getByRequestId(
        proposal.tradeRequestId,
      );
      if (existing) {
        if (existing.status === 'CONFIRMED')
          return { kind: 'CONFIRMED', execution: existing };
        if (existing.status === 'SUBMITTED')
          return { kind: 'SUBMITTED', execution: existing };
        if (existing.status === 'UNKNOWN')
          return { kind: 'UNKNOWN', execution: existing };
        return { kind: 'DUPLICATE', execution: existing };
      }
      return { kind: 'FAILED', reason: 'DUPLICATE_IN_FLIGHT' };
    }

    // Anything from here until `submitStarted = true` is pre-submit and safe
    // to release the lock on rejection. After that, the lock is NEVER released
    // automatically — a retry could double-submit.
    let submitStarted = false;

    try {
      // Stage 3: kill switch recheck (Rule 14) — side-aware (audit fix C2):
      // the switch blocks new risk (BUYs); SELLs stay available so /pause or
      // /emergency can never trap open positions with no way to flatten.
      if (proposal.proposal.side === 'BUY') {
        const ks = await this.deps.killSwitch.get();
        if (ks.active) {
          await this.deps.idempotency.release(
            this.execKey(proposal.tradeRequestId),
          );
          logger.warn(
            {
              event: 'EXECUTION_BLOCKED',
              tradeRequestId: proposal.tradeRequestId,
              reason: 'KILL_SWITCH_ACTIVE',
            },
            'Execution blocked by kill switch',
          );
          return { kind: 'REJECTED', reason: 'KILL_SWITCH_ACTIVE' };
        }
      }

      // Stage 3.2 (audit C2): fail-closed ledger health. Portfolio state may
      // be missing fills (reconciliation pending) or contradict confirmed
      // fills (booking failure). Sizing NEW risk against such state is how
      // positions and PnL drift from reality — BUYs are blocked while the
      // repair queue is non-empty. SELLs are never blocked (exits must stay
      // available, failure mode C2 of the 2026-11-08 audit).
      if (proposal.proposal.side === 'BUY') {
        const health = await this.deps.fillLedger.isLedgerHealthy();
        if (!health.healthy) {
          await this.deps.idempotency.release(
            this.execKey(proposal.tradeRequestId),
          );
          logger.error(
            {
              event: 'LEDGER_BUY_BLOCKED',
              tradeRequestId: proposal.tradeRequestId,
              unresolved: health.unresolved,
              detail: health.detail,
            },
            'New BUY blocked — ledger has unbooked or uncertain fills (repair queue non-empty)',
          );
          return { kind: 'REJECTED', reason: 'LEDGER_UNRESOLVED_FILLS' };
        }
      }

      // Stage 4: risk re-evaluation (catches stale quotes)
      const fresh = await this.deps.riskEngine.evaluate(proposal.proposal);
      if (!fresh.allowed) {
        await this.deps.idempotency.release(
          this.execKey(proposal.tradeRequestId),
        );
        logger.warn(
          {
            event: 'EXECUTION_BLOCKED',
            tradeRequestId: proposal.tradeRequestId,
            reason: fresh.reason,
          },
          'Execution blocked by risk re-evaluation',
        );
        return { kind: 'REJECTED', reason: fresh.reason ?? 'RISK_REJECTED' };
      }

      // Stage 4.5 (SELL): resolve the position BEFORE submission so the
      // provider knows the exact token quantity to sell. Failing here is a
      // pre-submit rejection (safe to retry later, unlike a fill with no
      // position on record).
      let sellTokenAmount: number | undefined;
      if (proposal.proposal.side === 'SELL') {
        const held = await this.deps.positions.get(proposal.proposal.tokenMint);
        if (!held || held.quantity <= 0) {
          await this.deps.idempotency.release(
            this.execKey(proposal.tradeRequestId),
          );
          logger.warn(
            {
              event: 'SELL_NO_POSITION',
              tradeRequestId: proposal.tradeRequestId,
              tokenMint: proposal.proposal.tokenMint,
            },
            'Sell rejected — no open position on record',
          );
          return { kind: 'REJECTED', reason: 'NO_OPEN_POSITION' };
        }
        const pct = proposal.proposal.sellPercentBps ?? 10_000;
        sellTokenAmount =
          held.quantity * (Math.min(Math.max(pct, 1), 10_000) / 10_000);
      }

      // Stage 5: provider safety gate (Rule 34)
      this.deps.provider.assertEnabled();

      // === POINT OF NO RETURN ===
      // From this line onward we DO NOT release the idempotency lock, even on
      // rejection, because a submission attempt may have reached the network.
      submitStarted = true;

      // Stage 6: SUBMIT
      const outcome = await this.deps.provider.execute({
        tradeRequestId: proposal.tradeRequestId,
        tokenMint: proposal.proposal.tokenMint,
        side: proposal.proposal.side,
        amountSol: proposal.proposal.amountSol,
        tokenAmount: sellTokenAmount,
        maxSlippageBps: proposal.proposal.expectedSlippageBps,
        maxPriceImpactBps: proposal.proposal.expectedPriceImpactBps,
        quoteFetchedAt: proposal.proposal.quoteFetchedAt,
      });

      // Stage 7: Persist execution record
      const stored: StoredExecution = {
        id: randomUUID(),
        proposalId: proposal.id,
        tradeRequestId: proposal.tradeRequestId,
        txSignature: outcome.txSignature || null,
        status: outcome.status,
        error: outcome.error,
        executedAt: Date.now(),
      };

      // Duplicate signature guard (Rule 24)
      if (outcome.txSignature) {
        const clash = await this.deps.executions.getBySignature(
          outcome.txSignature,
        );
        if (clash) {
          logger.error(
            {
              event: 'DUPLICATE_SIGNATURE',
              tradeRequestId: proposal.tradeRequestId,
              txSignature: outcome.txSignature,
            },
            'Duplicate tx signature — refusing to persist',
          );
          // Keep the lock: this submission reached the network and produced a signature.
          return { kind: 'FAILED', reason: 'DUPLICATE_TX_SIGNATURE' };
        }
      }

      await this.deps.executions.save(stored);

      if (outcome.status === 'CONFIRMED') {
        await this.deps.proposals.updateStatus(proposal.id, 'EXECUTED');
        await this.bookConfirmedFill(proposal, stored, outcome);
        logger.info(
          {
            event: 'EXECUTION_CONFIRMED',
            tradeRequestId: proposal.tradeRequestId,
            txSignature: outcome.txSignature,
            provider: this.deps.provider.name,
          },
          'Execution confirmed',
        );
        return { kind: 'CONFIRMED', execution: stored };
      }

      if (outcome.status === 'SUBMITTED') {
        await this.deps.proposals.updateStatus(proposal.id, 'SUBMITTED');
        logger.info(
          {
            event: 'EXECUTION_SUBMITTED',
            tradeRequestId: proposal.tradeRequestId,
            txSignature: outcome.txSignature,
          },
          'Execution submitted — awaiting confirmation (reconcile later)',
        );
        return { kind: 'SUBMITTED', execution: stored };
      }

      if (outcome.status === 'UNKNOWN') {
        await this.deps.proposals.updateStatus(proposal.id, 'UNKNOWN');
        logger.error(
          {
            event: 'EXECUTION_UNKNOWN',
            tradeRequestId: proposal.tradeRequestId,
            error: outcome.error,
          },
          'Execution state UNKNOWN — lock retained, manual reconciliation required',
        );
        return { kind: 'UNKNOWN', execution: stored };
      }

      await this.deps.proposals.updateStatus(proposal.id, 'FAILED');
      logger.error(
        {
          event: 'EXECUTION_FAILED',
          tradeRequestId: proposal.tradeRequestId,
          error: outcome.error,
        },
        'Execution failed at provider',
      );
      return { kind: 'FAILED', reason: outcome.error ?? 'PROVIDER_FAILED' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'UNKNOWN';

      if (!submitStarted) {
        // Pre-submit exception: safe to release the lock.
        await this.deps.idempotency.release(
          this.execKey(proposal.tradeRequestId),
        );
        logger.error(
          {
            event: 'EXECUTION_ERROR_PRE_SUBMIT',
            tradeRequestId: proposal.tradeRequestId,
            err,
          },
          'Pre-submit error',
        );
        return { kind: 'FAILED', reason };
      }

      // Post-submit exception: NEVER release the lock.
      logger.error(
        {
          event: 'EXECUTION_ERROR_POST_SUBMIT',
          tradeRequestId: proposal.tradeRequestId,
          err,
        },
        'Post-submit error — recording as UNKNOWN',
      );
      const unknownStored: StoredExecution = {
        id: randomUUID(),
        proposalId: proposal.id,
        tradeRequestId: proposal.tradeRequestId,
        txSignature: null,
        status: 'UNKNOWN',
        error: reason,
        executedAt: Date.now(),
      };
      try {
        await this.deps.executions.save(unknownStored);
        await this.deps.proposals.updateStatus(proposal.id, 'UNKNOWN');
      } catch (saveErr) {
        logger.error(
          {
            event: 'UNKNOWN_PERSIST_FAILED',
            tradeRequestId: proposal.tradeRequestId,
            saveErr,
          },
          'Failed to persist UNKNOWN execution — this is severe, manual reconciliation needed',
        );
      }
      return { kind: 'UNKNOWN', execution: unknownStored };
    }
  }

  /**
   * Audit C1: booking goes through THE canonical FillLedger — idempotent,
   * transactional, shared with the reconciliation runner. A booking failure
   * must NEVER regress a confirmed execution to UNKNOWN (the chain state is
   * fact); it lands in the repair queue and blocks new BUYs instead.
   */
  private async bookConfirmedFill(
    proposal: StoredProposal,
    stored: StoredExecution,
    outcome: {
      filledAmountSol: number;
      filledTokenAmount: number;
      txSignature: string;
    },
  ): Promise<void> {
    if (!(outcome.filledTokenAmount > 0) || !(outcome.filledAmountSol > 0)) {
      // The provider must never report CONFIRMED without usable amounts;
      // if it does, queue it for repair rather than fabricating a position.
      logger.error(
        {
          event: 'LEDGER_BOOKING_UNRESOLVED',
          tradeRequestId: proposal.tradeRequestId,
          reason: 'UNUSABLE_FILL_AMOUNTS',
          tokens: outcome.filledTokenAmount,
          sol: outcome.filledAmountSol,
        },
        'Confirmed outcome lacks usable fill amounts — repair queue holds it; new BUYs blocked',
      );
      return;
    }
    try {
      const result = await this.deps.fillLedger.bookFill({
        executionId: stored.id,
        proposalId: proposal.id,
        tradeRequestId: proposal.tradeRequestId,
        side: proposal.proposal.side,
        tokenMint: proposal.proposal.tokenMint,
        txSignature: outcome.txSignature,
        filledTokenAmount: outcome.filledTokenAmount,
        filledAmountSol: outcome.filledAmountSol,
        source: 'IMMEDIATE',
      });
      switch (result.kind) {
        case 'BOOKED':
          logger.info(
            {
              event: 'EXECUTION_FILL_BOOKED',
              tradeRequestId: proposal.tradeRequestId,
              txSignature: outcome.txSignature,
              source: 'IMMEDIATE',
            },
            'Confirmed fill booked into positions',
          );
          if (result.realizedPnlSol !== undefined) {
            logger.info(
              {
                event: 'PNL_RECORDED',
                tradeRequestId: proposal.tradeRequestId,
                realizedSol: result.realizedPnlSol,
              },
              'Realized PnL recorded',
            );
          }
          break;
        case 'ALREADY_BOOKED':
          logger.warn(
            { event: 'FILL_ALREADY_BOOKED', tradeRequestId: proposal.tradeRequestId, txSignature: outcome.txSignature },
            'Fill was already booked (idempotent replay) — no double counting',
          );
          break;
        case 'UNRECONCILABLE':
          logger.error(
            {
              event: 'LEDGER_BOOKING_UNRESOLVED',
              tradeRequestId: proposal.tradeRequestId,
              reason: result.reason,
            },
            'Confirmed fill violates booking invariants — repair queue holds it; new BUYs blocked',
          );
          break;
        case 'QUEUED':
          logger.error(
            {
              event: 'LEDGER_BOOKING_UNRESOLVED',
              tradeRequestId: proposal.tradeRequestId,
              reason: result.error,
            },
            'Fill booking failed transiently — repair queue holds it; new BUYs blocked',
          );
          break;
      }
    } catch (err) {
      // The ledger is unreachable — the execution stays CONFIRMED (chain
      // fact), and the reconciliation runner's repair sweep will discover
      // this CONFIRMED-without-booking row and re-attempt.
      logger.error(
        {
          event: 'LEDGER_BOOKING_ERROR',
          tradeRequestId: proposal.tradeRequestId,
          err,
        },
        'Fill ledger threw during booking — repair sweep will re-attempt; new BUYs blocked once visible',
      );
    }
  }
}
