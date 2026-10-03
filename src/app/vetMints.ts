export interface VetPair {
  chainId: string;
  baseToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
}

export interface VetThresholds {
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minAgeHours: number;
}

export const DEFAULT_VET_THRESHOLDS: VetThresholds = {
  minLiquidityUsd: 100_000,
  minVolume24hUsd: 250_000,
  minAgeHours: 24,
};

export type VetStatus = 'PASS' | 'NO_PAIR' | 'INCOMPLETE' | 'LOW_LIQUIDITY' | 'LOW_VOLUME' | 'TOO_NEW';

export interface VetResult {
  mint: string;
  status: VetStatus;
  symbol?: string;
  liquidityUsd?: number;
  volume24hUsd?: number;
  ageHours?: number;
}

/**
 * Rule 30: missing fields are INCOMPLETE, never treated as zero.
 * Only pairs where the mint is the BASE token count (same rule as the
 * DexScreener provider); the most liquid such pair represents the mint.
 */
export function vetMint(
  mint: string,
  pairs: VetPair[],
  now: number,
  t: VetThresholds = DEFAULT_VET_THRESHOLDS,
): VetResult {
  const base = pairs.filter((p) => p.chainId === 'solana' && p.baseToken?.address === mint);
  if (base.length === 0) return { mint, status: 'NO_PAIR' };

  const withLiq = base.filter((p) => typeof p.liquidity?.usd === 'number');
  if (withLiq.length === 0) return { mint, status: 'INCOMPLETE', symbol: base[0].baseToken?.symbol };

  const best = withLiq.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
  const liquidityUsd = best.liquidity?.usd;
  const volume24hUsd = best.volume?.h24;
  const created = best.pairCreatedAt;
  const symbol = best.baseToken?.symbol;

  if (typeof volume24hUsd !== 'number' || typeof created !== 'number') {
    return { mint, status: 'INCOMPLETE', symbol, liquidityUsd, volume24hUsd };
  }

  const ageHours = (now - created) / 3_600_000;
  const common = { mint, symbol, liquidityUsd, volume24hUsd, ageHours };
  if ((liquidityUsd ?? 0) < t.minLiquidityUsd) return { ...common, status: 'LOW_LIQUIDITY' };
  if (volume24hUsd < t.minVolume24hUsd) return { ...common, status: 'LOW_VOLUME' };
  if (ageHours < t.minAgeHours) return { ...common, status: 'TOO_NEW' };
  return { ...common, status: 'PASS' };
}
