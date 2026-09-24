import { StrategyVerdictStore } from '../state/strategyVerdicts';

/**
 * Rule 17: stages must not be skipped.
 * Rule 6: the risk engine has final authority — this gate is called by the
 * orchestrator BEFORE the risk engine, so an unapproved strategy never even
 * reaches evaluation in live mode.
 */
export class StrategyGate {
  constructor(
    private readonly store: StrategyVerdictStore,
    private readonly enabled: boolean,
  ) {}

  /**
   * Returns null if the strategy is permitted to produce proposals.
   * Returns a rejection reason otherwise.
   */
  async check(strategyName: string, strategyVersion: string): Promise<string | null> {
    if (!this.enabled) return null;
    const approved = await this.store.isApproved(strategyName, strategyVersion);
    return approved ? null : `STRATEGY_NOT_APPROVED:${strategyName}@${strategyVersion}`;
  }
}
