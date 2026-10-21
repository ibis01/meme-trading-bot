import { randomUUID } from 'crypto';
import { Signal } from '../strategy/types';
import { TradeProposal } from '../risk/types';
import { RiskEngine } from '../risk/engine';
import { SecurityProvider } from '../security';
import { IdempotencyService } from '../infra/idempotency';
import { ProposalStore, StoredProposal } from '../state/proposals';
import { SignalStore } from '../state/signals';
import { StrategyGate } from '../risk/strategyGate';
import { logger } from '../utils/logger';

export interface OrchestratorDeps {
  riskEngine: RiskEngine;
  security: SecurityProvider;
  idempotency: IdempotencyService;
  proposals: ProposalStore;
  signals: SignalStore;
  strategyGate?: StrategyGate;
  namespace?: string;
  /** Optional: persist rejections to a dedicated audit table. */
  rejectionStore?: {
    saveRejection(input: {
      tradeRequestId: string;
      tokenMint: string;
      strategy: string;
      strategyVersion: string;
      reasonCode: string;
      evidence: Record<string, unknown>;
    }): Promise<void>;
  };
}

export type OrchestratorResult =
  | { kind: 'APPROVED'; stored: StoredProposal }
  | { kind: 'REJECTED'; stored: StoredProposal }
  | { kind: 'DUPLICATE'; stored: StoredProposal }
  | { kind: 'ERROR'; reason: string };

export class ProposalOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  private requestIdFor(signal: Signal): string {
    const ns = this.deps.namespace ?? 'sig';
    return `${ns}:${signal.id}`;
  }

  async process(signal: Signal): Promise<OrchestratorResult> {
    const tradeRequestId = this.requestIdFor(signal);

    // Rule 17: gate check BEFORE any state mutation (except idempotency).
    if (this.deps.strategyGate) {
      const reason = await this.deps.strategyGate.check(
        signal.strategy,
        signal.strategyVersion,
      );
      if (reason) {
        logger.warn(
          { event: 'STRATEGY_GATE_BLOCKED', tradeRequestId, reason },
          'Strategy gate rejected signal',
        );
        // Persist rejection evidence for auditability.
        if (this.deps.rejectionStore) {
          await this.deps.rejectionStore.saveRejection({
            tradeRequestId,
            tokenMint: signal.tokenMint,
            strategy: signal.strategy,
            strategyVersion: signal.strategyVersion,
            reasonCode: reason,
            evidence: { stage: 'STRATEGY_GATE', signal },
          });
        }
        return { kind: 'ERROR', reason };
      }
    }

    const firstTime = await this.deps.idempotency.acquire(tradeRequestId);
    if (!firstTime) {
      const existing = await this.deps.proposals.getByRequestId(tradeRequestId);
      if (existing) return { kind: 'DUPLICATE', stored: existing };
      return { kind: 'ERROR', reason: 'DUPLICATE_IN_FLIGHT' };
    }

    try {
      await this.deps.signals.save(signal);

      const security = await this.deps.security.check(signal.tokenMint);

      const proposal: TradeProposal = {
        tokenMint: signal.tokenMint,
        side: signal.side,
        amountSol: signal.proposedAmountSol,
        expectedSlippageBps: signal.proposedSlippageBps,
        expectedPriceImpactBps: signal.proposedPriceImpactBps,
        sellPercentBps: signal.sellPercentBps,
        quoteFetchedAt: Date.now(),
        security,
      };

      const decision = await this.deps.riskEngine.evaluate(proposal);

      const stored: StoredProposal = {
        id: randomUUID(),
        tradeRequestId,
        signalId: signal.id,
        proposal,
        decision,
        status: decision.allowed ? 'APPROVED' : 'REJECTED',
        createdAt: Date.now(),
      };

      await this.deps.proposals.save(stored);

      // Persist rejection evidence for auditability.
      if (!decision.allowed && this.deps.rejectionStore) {
        await this.deps.rejectionStore.saveRejection({
          tradeRequestId,
          tokenMint: signal.tokenMint,
          strategy: signal.strategy,
          strategyVersion: signal.strategyVersion,
          reasonCode: decision.reason ?? 'UNKNOWN_REJECTION',
          evidence: decision.evidence ?? {},
        });
      }

      logger.info(
        {
          event: decision.allowed ? 'PROPOSAL_APPROVED' : 'TRADE_REJECTED',
          token: signal.tokenMint,
          strategy: signal.strategy,
          tradeRequestId,
          reason: decision.reason,
        },
        decision.allowed ? 'Proposal approved' : 'Proposal rejected',
      );

      return decision.allowed
        ? { kind: 'APPROVED', stored }
        : { kind: 'REJECTED', stored };
    } catch (err) {
      await this.deps.idempotency.release(tradeRequestId);
      logger.error({ err, tradeRequestId }, 'Orchestrator failed');
      return {
        kind: 'ERROR',
        reason: err instanceof Error ? err.message : 'UNKNOWN',
      };
    }
  }
}
