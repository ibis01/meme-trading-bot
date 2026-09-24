import { DexName } from '../poolEvents/types';

/**
 * A newly-created token/pool event, sourced from a public indexer.
 * Same shape as PoolEvent so downstream code is unchanged, but includes
 * enrichment data the indexer already provides.
 */
export interface NewPairEvent {
  source: string;
  dex: DexName;
  tokenMint: string;
  poolAddress?: string;
  quoteMint?: string;
  creatorWallet?: string;
  signature?: string;
  detectedAt: number;
  /** Present when the indexer provides it. */
  priceUsd?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  holderCount?: number;
  marketCapUsd?: number;
  /** Raw payload from the source, for debugging. */
  raw?: unknown;
}

export interface NewPairSource {
  readonly name: string;
  /** Fetch events created after `sinceMs`. */
  fetchNew(sinceMs: number): Promise<NewPairEvent[]>;
}
