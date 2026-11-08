import { Signal } from '../strategy/types';
import { SecurityProvider } from '../security/types';
import { DebateService, DebateResult } from './service';

/**
 * The minimal interface the orchestrator depends on. Mirrors the
 * rejectionStore precedent: an optional dep + a guarded block. The
 * orchestrator never sees the LLM client, the store, or the budget — only the
 * veto decision + evidence for the audit row.
 *
 * Rule 28: advisory only. shouldVeto=true can only REDUCE entries (advise
 * mode). The risk engine still evaluates everything that passes.
 */
export interface DebateAdvisor {
  advise(input: { signal: Signal; tradeRequestId: string }): Promise<DebateResult>;
}

/**
 * Production advisor: wraps DebateService and fetches security evidence for
 * the debate input. The security fetch is advisory-context-only — the risk
 * engine fetches its own authoritative evidence later in the pipeline, so a
 * transient difference between the two is acceptable (the debate is advisory,
 * the risk engine is final).
 *
 * Never throws. On any internal failure the wrapped DebateService returns
 * UNAVAILABLE/SKIPPED with shouldVeto=false (fail-open).
 */
export class ProductionDebateAdvisor implements DebateAdvisor {
  constructor(
    private readonly service: DebateService,
    private readonly security: SecurityProvider,
  ) {}

  async advise(input: {
    signal: Signal;
    tradeRequestId: string;
  }): Promise<DebateResult> {
    // BUY-only (§4): SELL signals skip debates — exits are never debated
    // (H1 precedent: capital-protection paths must not wait on advisory layers).
    if (input.signal.side !== 'BUY') {
      return { kind: 'SKIPPED', shouldVeto: false, reason: 'NOT_BUY' };
    }

    let security;
    try {
      security = await this.security.check(input.signal.tokenMint);
    } catch (err) {
      // Fail-open: no security evidence → no debate. The risk engine will
      // independently reject if security is genuinely unavailable.
      return {
        kind: 'UNAVAILABLE',
        shouldVeto: false,
        reason: `SECURITY_FETCH_FAILED:${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return this.service.advise({
      signal: input.signal,
      tradeRequestId: input.tradeRequestId,
      security,
    });
  }
}
