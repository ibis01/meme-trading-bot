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
