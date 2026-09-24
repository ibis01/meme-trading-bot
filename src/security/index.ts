import { SecurityProvider, TokenSecurityEvidence, unsafeEvidence } from './types';
export * from './types';
export * from './rugcheck';

export class MockSecurityProvider implements SecurityProvider {
  readonly name = 'mock';
  constructor(private readonly overrides: Partial<TokenSecurityEvidence> = {}) {}

  async check(tokenMint: string): Promise<TokenSecurityEvidence> {
    return {
      tokenMint,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      top10HolderPercent: 20,
      devWalletPercent: 2,
      liquidityUsd: 100_000,
      sellabilityConfirmed: true,
      fetchedAt: Date.now(),
      source: 'mock',
      ...this.overrides,
    };
  }
}
