export interface TokenSecurityEvidence {
  tokenMint: string;
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  top10HolderPercent: number;
  devWalletPercent: number;
  liquidityUsd: number;
  sellabilityConfirmed: boolean;
  fetchedAt: number;
  source: 'rugcheck' | 'helius' | 'mock';
}

export interface SecurityProvider {
  readonly name: string;
  check(tokenMint: string): Promise<TokenSecurityEvidence>;
}

/** Fails closed: unsafe defaults so the risk engine rejects on error. */
export function unsafeEvidence(
  tokenMint: string,
  source: TokenSecurityEvidence['source'],
): TokenSecurityEvidence {
  return {
    tokenMint,
    mintAuthorityDisabled: false,
    freezeAuthorityDisabled: false,
    top10HolderPercent: 100,
    devWalletPercent: 100,
    liquidityUsd: 0,
    sellabilityConfirmed: false,
    fetchedAt: Date.now(),
    source,
  };
}
