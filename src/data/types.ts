import { MarketSnapshot } from '../strategy/types';

export interface MarketDataProvider {
  readonly name: string;
  /** Fetch a full market snapshot. Must throw or return null if data is incomplete. */
  fetchSnapshot(tokenMint: string): Promise<MarketSnapshot | null>;
}
