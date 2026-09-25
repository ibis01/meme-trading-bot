import { MarketSnapshot } from '../strategy/types';
import { MarketDataProvider } from './types';
import { logger } from '../utils/logger';

interface DexPair {
  chainId: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { m5?: number; h1?: number };
}

interface DexResponse {
  pairs?: DexPair[];
}

/**
 * DexScreener market data provider.
 *
 * Rate limit: ~300 req/min for token queries. No API key required.
 * Docs: https://docs.dexscreener.com/api/reference
 *
 * Rule 30: returns null if any required field is missing — never guesses.
 */
export class DexScreenerMarketProvider implements MarketDataProvider {
  readonly name = 'dexscreener';

  constructor(
    private readonly baseUrl = 'https://api.dexscreener.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchSnapshot(tokenMint: string): Promise<MarketSnapshot | null> {
    try {
      const url = `${this.baseUrl}/latest/dex/tokens/${encodeURIComponent(tokenMint)}`;
      const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`DexScreener HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const json = (await res.json()) as DexResponse;
      const solana = (json.pairs ?? []).filter((p) => p.chainId === 'solana');
      if (solana.length === 0) {
        logger.warn(
          { event: 'DEXSCREENER_NO_SOLANA_PAIR', token: tokenMint },
          'DexScreener returned no Solana pairs — refusing to build snapshot',
        );
        return null;
      }

      // Rule 30: priceUsd is the price of the BASE token of the pair, not
      // of the queried mint. Only pairs where the queried mint is the base
      // give us the mint's own USD price. If none exist, return null — do
      // NOT fall back to quote-side pairs (their priceUsd belongs to the
      // other token, and using it would silently misprice the position).
      const baseSide = solana.filter((p) => p.baseToken?.address === tokenMint);
      if (baseSide.length === 0) {
        logger.warn(
          { event: 'DEXSCREENER_NO_BASE_SIDE_PAIR', token: tokenMint },
          'No Solana pair lists this mint as baseToken — refusing to guess priceUsd from a quote-side pair',
        );
        return null;
      }

      const best = baseSide.reduce((a, b) =>
        (a.liquidity?.usd ?? 0) >= (b.liquidity?.usd ?? 0) ? a : b,
      );

      const priceUsd = numOrNull(best.priceUsd);
      const liquidityUsd = numOrNull(best.liquidity?.usd);
      const volume24hUsd = numOrNull(best.volume?.h24);
      // Rule 30 note: DexScreener omits priceChange.m5/h1 when the value
      // rounds to zero at their display precision. Treat absent as 0 —
      // that IS the value. Absent is not the same as a malformed pair.
      const priceChange5mPercent = numOrZero(best.priceChange?.m5);
      const priceChange1hPercent = numOrZero(best.priceChange?.h1);

      if (
        priceUsd === null || priceUsd <= 0 ||
        liquidityUsd === null ||
        volume24hUsd === null
      ) {
        logger.warn(
          { event: 'DEXSCREENER_DATA_INCOMPLETE', token: tokenMint },
          'DexScreener returned incomplete data — refusing to build snapshot',
        );
        return null;
      }

      return {
        tokenMint,
        fetchedAt: Date.now(),
        priceUsd,
        liquidityUsd,
        volume24hUsd,
        priceChange5mPercent,
        priceChange1hPercent,
      };
    } catch (err) {
      logger.error(
        { event: 'DEXSCREENER_DATA_ERROR', token: tokenMint, err },
        'DexScreener fetch failed',
      );
      return null;
    }
  }
}

function numOrZero(v: unknown): number {
  const n = numOrNull(v);
  return n === null ? 0 : n;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
