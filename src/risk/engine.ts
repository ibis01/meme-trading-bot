import { KillSwitchStore } from '../state/killSwitch';
import { PnlStore } from '../state/dailyPnl';
import { PositionStore } from '../state/positions';
import { evaluateRisk } from './evaluate';
import { RiskDecision, RiskSnapshot, TradeProposal } from './types';

export interface RiskEngineStores {
  killSwitch: KillSwitchStore;
  pnl: PnlStore;
  positions: PositionStore;
}

/**
 * Rule 6: The RiskEngine builds its own authoritative snapshot.
 * Callers cannot inject or fake `killSwitchActive`, `dailyPnLSol`,
 * or `currentOpenPositions`.
 */
export class RiskEngine {
  constructor(private readonly stores: RiskEngineStores) {}

  async evaluate(proposal: TradeProposal): Promise<RiskDecision> {
    const snapshot = await this.buildSnapshot();
    return evaluateRisk(proposal, snapshot);
  }

  private async buildSnapshot(): Promise<RiskSnapshot> {
    const [ks, pnl, openPositions] = await Promise.all([
      this.stores.killSwitch.get(),
      this.stores.pnl.getToday(),
      this.stores.positions.getOpenCount(),
    ]);
    return {
      killSwitchActive: ks.active,
      dailyPnLSol: pnl,
      currentOpenPositions: openPositions,
      now: Date.now(),
    };
  }
}
