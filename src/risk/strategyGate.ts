import { StrategyVerdictStore } from '../state/strategyVerdicts';

export class StrategyGate {
  constructor(
    private readonly store: StrategyVerdictStore,
    private readonly enabled: boolean,
    private readonly alwaysAllowedStrategies: readonly string[] = [],
  ) {}

  /**
   * Returns null if the strategy is permitted to produce proposals.
   * Returns a rejection reason otherwise.
   *
   * FAIL-CLOSED: if the gate is not explicitly enabled, it must reject.
   * A disabled gate cannot be assumed to mean "permit all" in a capital-handling system.
   */
  async check(
    strategyName: string,
    strategyVersion: string,
  ): Promise<string | null> {
    // 1. Fail-closed if the gate is not explicitly enabled.
    if (!this.enabled) {
      return 'STRATEGY_GATE_DISABLED';
    }

    // 2. Exit strategies are always allowed (risk-reducing).
    if (this.alwaysAllowedStrategies.includes(strategyName)) {
      return null;
    }

    // 3. Entries require explicit approval from the verdict store.
    const approved = await this.store.isApproved(strategyName, strategyVersion);
    return approved
      ? null
      : `STRATEGY_NOT_APPROVED:${strategyName}@${strategyVersion}`;
  }
}
