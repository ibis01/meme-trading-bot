import { MarketDataProvider } from './types';
import { MarketSnapshot } from '../strategy/types';
import { logger } from '../utils/logger';

/**
 * VERIFY BEFORE LIVE USE (Rule 30):
 *   https://docs.helius.dev/
 * Field names in `parseDAS` and `parseRpc` are placeholders. Confirm against
 * the current DAS / RPC responses before trusting them.
 * If any required field is missing, this provider returns null so the caller
 * never produces a signal on incomplete data.
 */
export class HeliusMarketProvider implements MarketDataProvider {
  readonly name = 'helius';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = 'https://mainnet.helius-rpc.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchSnapshot(tokenMint: string): Promise<MarketSnapshot | null> {
    try {
      const asset = await this.getAsset(tokenMint);
      if (!asset) return null;

      // --- Required fields (all must be present; anything missing → null) ---
      const liquidityUsd = numOrNull(asset.liquidityUsd);
      const priceUsd = numOrNull(asset.priceUsd);
      const volume24hUsd = numOrNull(asset.volume24hUsd);
      const holderCount = intOrNull(asset.holderCount);
      const top10HolderPercent = numOrNull(asset.top10HolderPercent);
      const smartWalletNetFlowUsd = numOrNull(asset.smartWalletNetFlowUsd);
      const priceChange5mPercent = numOrNull(asset.priceChange5mPercent);
      const priceChange1hPercent = numOrNull(asset.priceChange1hPercent);

      if (
        liquidityUsd === null ||
        priceUsd === null ||
        volume24hUsd === null ||
        holderCount === null ||
        top10HolderPercent === null ||
        smartWalletNetFlowUsd === null ||
        priceChange5mPercent === null ||
        priceChange1hPercent === null
      ) {
        logger.warn(
          { event: 'MARKET_DATA_INCOMPLETE', token: tokenMint, provider: this.name },
          'Helius returned incomplete data — refusing to build snapshot',
        );
        return null;
      }

      return {
        tokenMint,
        fetchedAt: Date.now(),
        priceUsd,
        liquidityUsd,
        volume24hUsd,
        holderCount,
        top10HolderPercent,
        smartWalletNetFlowUsd,
        priceChange5mPercent,
        priceChange1hPercent,
      };
    } catch (err) {
      logger.error(
        { event: 'MARKET_DATA_ERROR', token: tokenMint, err },
        'Helius fetch failed',
      );
      return null;
    }
  }

  /** VERIFY: exact DAS endpoint and response shape for token metadata. */
  private async getAsset(tokenMint: string): Promise<Record<string, unknown> | null> {
    const url = `${this.baseUrl}/?api-key=${this.apiKey}`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'market-snapshot',
        method: 'getAsset',
        params: { id: tokenMint },
      }),
    });
    if (!res.ok) throw new Error(`Helius HTTP ${res.status}`);
    const json = (await res.json()) as { result?: Record<string, unknown> };
    return json.result ?? null;
  }
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function intOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n !== null && Number.isInteger(n) ? n : null;
}
