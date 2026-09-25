import { MarketSnapshot } from '../strategy/types';
import { MarketDataProvider } from './types';
import { logger } from '../utils/logger';

/**
 * VERIFY BEFORE LIVE USE (Rule 30):
 *   https://docs.birdeye.so/reference/get-defi-token-overview
 * Field names below are the documented ones as of writing; confirm against
 * the current Birdeye response before trusting them.
 *
 * Returns null if any required field is missing (Rule 30: never guess).
 */
export class BirdeyeMarketProvider implements MarketDataProvider {
  readonly name = 'birdeye';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://public-api.birdeye.so',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchSnapshot(tokenMint: string): Promise<MarketSnapshot | null> {
    try {
      const url = `${this.baseUrl}/defi/token_overview?address=${encodeURIComponent(tokenMint)}`;
      const res = await this.fetchImpl(url, {
        headers: { 'X-API-KEY': this.apiKey, accept: 'application/json', 'x-chain': 'solana' },
      });
      if (!res.ok) {
        const body = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
        throw new Error(`Birdeye HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: Record<string, unknown> };
      const d = json.data;
      if (!d) return null;

      const priceUsd = numOrNull(d.price);
      const liquidityUsd = numOrNull(d.liquidity);
      const volume24hUsd = numOrNull(d.v24hUSD);
      const holderCount = intOrNull(d.holder);
      const priceChange5mPercent = numOrNull(d.priceChange5mPercent);
      const priceChange1hPercent = numOrNull(d.priceChange1hPercent);

      if (
        priceUsd === null || priceUsd <= 0 ||
        liquidityUsd === null ||
        volume24hUsd === null ||
        holderCount === null ||
        priceChange5mPercent === null ||
        priceChange1hPercent === null
      ) {
        logger.warn(
          { event: 'BIRDEYE_DATA_INCOMPLETE', token: tokenMint },
          'Birdeye returned incomplete data — refusing to build snapshot',
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
        // Rule 30: Birdeye does not expose holder concentration. Leave undefined.
        // top10HolderPercent: undefined
        // smartWalletNetFlowUsd: undefined
        priceChange5mPercent,
        priceChange1hPercent,
      };
    } catch (err) {
      logger.error(
        { event: 'BIRDEYE_DATA_ERROR', token: tokenMint, err },
        'Birdeye fetch failed',
      );
      return null;
    }
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
