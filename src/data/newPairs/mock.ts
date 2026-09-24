import { NewPairSource, NewPairEvent } from './types';

export class MockNewPairSource implements NewPairSource {
  readonly name = 'mock-new-pairs';
  constructor(private readonly events: NewPairEvent[]) {}

  async fetchNew(sinceMs: number): Promise<NewPairEvent[]> {
    return this.events.filter((e) => e.detectedAt >= sinceMs);
  }
}

export function makeNewPairEvent(overrides: Partial<NewPairEvent> = {}): NewPairEvent {
  return {
    source: 'mock',
    dex: 'pumpfun',
    tokenMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    quoteMint: 'So11111111111111111111111111111111111111112',
    detectedAt: Date.now(),
    liquidityUsd: 5000,
    ...overrides,
  };
}
