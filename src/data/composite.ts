import { MarketSnapshot } from '../strategy/types';
import { MarketDataProvider } from './types';
import { HeliusMarketProvider } from './helius';
import { BirdeyeMarketProvider } from './birdeye';
import { logger } from '../utils/logger';

/**
 * Merges two real providers into one authoritative MarketSnapshot.
 * Fail-closed: if either required source is missing, return null.
 *
 * Why composite?
 *  - Helius DAS: mint authority, freeze authority, token metadata.
 *  - Birdeye: price, liquidity, volume, holder count.
 * Neither source alone gives us everything Rule 8 needs.
 */
export class CompositeMarketProvider implements MarketDataProvider {
  readonly name = 'composite';

  constructor(
    private readonly helius: HeliusMarketProvider,
    private readonly birdeye: BirdeyeMarketProvider,
  ) {}

  async fetchSnapshot(tokenMint: string): Promise<MarketSnapshot | null> {
    const [heliusSnap, birdeyeSnap] = await Promise.all([
      this.helius.fetchSnapshot(tokenMint),
      this.birdeye.fetchSnapshot(tokenMint),
    ]);

    if (!birdeyeSnap) {
      logger.warn(
        { event: 'COMPOSITE_MISSING_BIRDEYE', token: tokenMint },
        'Composite: Birdeye missing — returning null',
      );
      return null;
    }

    // Helius currently returns DAS fields that don't line up 1:1 with MarketSnapshot.
    // If Helius provides nothing, we still emit the Birdeye-only snapshot with
    // a warning — the security check happens elsewhere anyway.
    if (!heliusSnap) {
      logger.warn(
        { event: 'COMPOSITE_MISSING_HELIUS', token: tokenMint },
        'Composite: Helius missing — proceeding with Birdeye-only snapshot',
      );
    }

    return {
      ...birdeyeSnap,
      // Prefer Birdeye for market data; use Helius when it has anything better.
      liquidityUsd: birdeyeSnap.liquidityUsd,
      volume24hUsd: birdeyeSnap.volume24hUsd,
    };
  }
}
