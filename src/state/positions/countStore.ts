/**
 * Narrow interface for consumers that only need the open-position count
 * (e.g. RiskEngine's MAX_OPEN_POSITIONS check). Kept separate from
 * PositionLedger so those consumers don't depend on the full ledger API.
 */
export interface PositionStore {
  getOpenCount(): Promise<number>;
  increment(): Promise<number>;
  decrement(): Promise<number>;
}

export class InMemoryPositionStore implements PositionStore {
  private count = 0;
  async getOpenCount(): Promise<number> { return this.count; }
  async increment(): Promise<number> { return ++this.count; }
  async decrement(): Promise<number> { return Math.max(0, --this.count); }
}
