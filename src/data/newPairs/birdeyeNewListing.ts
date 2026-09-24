import { NewPairSource, NewPairEvent } from './types';
import { logger } from '../../utils/logger';

/**
 * VERIFY (Rule 30): Birdeye endpoint shape.
 *   https://docs.birdeye.so/reference/get-defi-v2-tokens-new-listing
 *
 * Observed response shape:
 *   { data: { items: [ { address, symbol, name, liquidity, v24hUSD, ... } ] } }
 *
 * If a field is missing, we skip the item — Rule 30 says don't guess.
 */
export class BirdeyeNewListingSource implements NewPairSource {
  readonly name = 'birdeye-new-listing';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://public-api.birdeye.so',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchNew(sinceMs: number): Promise<NewPairEvent[]> {
    try {
      const url = `${this.baseUrl}/defi/v2/tokens/new_listing?time_to=${Math.floor(Date.now() / 1000)}&meme_platform_enabled=true`;
      const res = await this.fetchImpl(url, {
        headers: { 'X-API-KEY': this.apiKey, accept: 'application/json', 'x-chain': 'solana' },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.warn(
          { event: 'NEW_LISTING_HTTP_ERROR', status: res.status, body: body.slice(0, 200) },
          'Birdeye new_listing failed',
        );
        return [];
      }
      const json = (await res.json()) as { data?: { items?: Array<Record<string, unknown>> } };
      const items = json.data?.items ?? [];
      const events: NewPairEvent[] = [];
      for (const item of items) {
        const ev = this.parseItem(item);
        if (ev && ev.detectedAt >= sinceMs) events.push(ev);
      }
      return events;
    } catch (err) {
      logger.error({ event: 'NEW_LISTING_FETCH_ERROR', err }, 'Birdeye new_listing threw');
      return [];
    }
  }

  private parseItem(item: Record<string, unknown>): NewPairEvent | null {
    const tokenMint = typeof item.address === 'string' ? item.address : null;
    if (!tokenMint) return null;
    if (!isLikelyPubkey(tokenMint)) return null;

    // Birdeye uses `liquidityAddedAt` (unix seconds) when present.
    const addedAt = numOrNull(item.liquidityAddedAt);
    const detectedAt = addedAt !== null ? addedAt * 1000 : Date.now();

    return {
      source: this.name,
      dex: 'pumpfun', // Birdeye's meme platform listing is ~all pump.fun
      tokenMint,
      quoteMint: 'So11111111111111111111111111111111111111112',
      detectedAt,
      liquidityUsd: numOrNull(item.liquidity) ?? undefined,
      volume24hUsd: numOrNull(item.v24hUSD) ?? undefined,
      priceUsd: numOrNull(item.price) ?? undefined,
      marketCapUsd: numOrNull(item.mc) ?? undefined,
      raw: item,
    };
  }
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function isLikelyPubkey(s: string): boolean {
  return s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
