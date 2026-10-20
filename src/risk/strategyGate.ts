import { StrategyVerdictStore } from '../state/strategyVerdicts';

/**
 * Rule 17: stages must not be skipped.
 * Rule 6: the risk engine has final authority — this gate is called by the
 * orchestrator BEFORE the risk engine, so an unapproved strategy never even
 * reaches evaluation in live mode.
 *
 * Audit fix H1: exit strategies are always allowed, even when unapproved.
 * Gating EXITS behind the verdicts table would recreate the C2 failure mode
 * (capital trapped because a safety path needs an approval row). Entries
 * still require explicit approval.
 */
export class StrategyGate {
  constructor(
    private readonly store: StrategyVerdictStore,
    private readonly enabled: boolean,
    private readonly alwaysAllowedStrategies: readonly string[] = [],
  ) {}

  /**
   * Returns null if the strategy is permitted to produce proposals.
   * Returns a rejection reason otherwise.
   */
  async check(
    strategyName: string,
    strategyVersion: string,
  ): Promise<string | null> {
    if (!this.enabled) return null;
    if (this.alwaysAllowedStrategies.includes(strategyName)) return null;
    const approved = await this.store.isApproved(strategyName, strategyVersion);
    return approved
      ? null
      : `STRATEGY_NOT_APPROVED:${strategyName}@${strategyVersion}`;
  }
}
