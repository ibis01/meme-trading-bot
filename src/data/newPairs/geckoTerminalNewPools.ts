import { NewPairSource, NewPairEvent } from './types';
import { DexName } from '../poolEvents/types';
import { logger } from '../../utils/logger';

const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * Keyless public GeckoTerminal API (~30 calls/min), no monthly compute-unit quota.
 *   GET /networks/solana/new_pools?page=N  (JSON:API; newest pools first)
 * Token ids look like "solana_<mint>" under relationships.base_token.data.id.
 *
 * Rule 30: any pool we cannot parse with certainty is skipped, never guessed.
 * Unmapped DEXes and pools whose base token is SOL are skipped.
 */
export class GeckoTerminalNewPoolsSource implements NewPairSource {
  readonly name = 'geckoterminal-new-pools';

  constructor(
    private readonly pages = 2,
    private readonly baseUrl = 'https://api.geckoterminal.com/api/v2',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchNew(sinceMs: number): Promise<NewPairEvent[]> {
    const events: NewPairEvent[] = [];
    for (let page = 1; page <= this.pages; page++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/networks/solana/new_pools?page=${page}`, {
          headers: { accept: 'application/json;version=20230302' },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          logger.warn(
            { event: 'GECKO_NEW_POOLS_HTTP_ERROR', status: res.status, page, body: body.slice(0, 200) },
            'GeckoTerminal new_pools failed',
          );
          break; // stop paging this tick (e.g. 429)
        }
        const json = (await res.json()) as { data?: Array<Record<string, unknown>> };
        for (const item of json.data ?? []) {
          const ev = this.parseItem(item);
          if (ev && ev.detectedAt >= sinceMs) events.push(ev);
        }
      } catch (err) {
        logger.error({ event: 'GECKO_NEW_POOLS_FETCH_ERROR', err }, 'GeckoTerminal new_pools threw');
        break;
      }
    }
    // Oldest first so the poller's since-cursor advances monotonically.
    return events.sort((a, b) => a.detectedAt - b.detectedAt);
  }

  private parseItem(item: Record<string, unknown>): NewPairEvent | null {
    const attrs = item.attributes as Record<string, unknown> | undefined;
    const rel = item.relationships as Record<string, { data?: { id?: string } }> | undefined;
    if (!attrs || !rel) return null;

    const tokenMint = mintFromId(rel.base_token?.data?.id);
    if (!tokenMint || tokenMint === WSOL) return null;

    const dex = mapDex(rel.dex?.data?.id);
    if (!dex) return null;

    const createdAt = typeof attrs.pool_created_at === 'string' ? Date.parse(attrs.pool_created_at) : NaN;
    if (!Number.isFinite(createdAt)) return null;

    return {
      source: this.name,
      dex,
      tokenMint,
      poolAddress: typeof attrs.address === 'string' ? attrs.address : undefined,
      quoteMint: mintFromId(rel.quote_token?.data?.id) ?? undefined,
      detectedAt: createdAt,
      priceUsd: numOrUndef(attrs.base_token_price_usd),
      liquidityUsd: numOrUndef(attrs.reserve_in_usd),
      volume24hUsd: numOrUndef((attrs.volume_usd as Record<string, unknown> | undefined)?.h24),
      marketCapUsd: numOrUndef(attrs.market_cap_usd),
      raw: item,
    };
  }
}

export function mapDex(id: string | undefined): DexName | null {
  if (!id) return null;
  const s = id.toLowerCase();
  if (s.includes('pumpswap') || s.includes('pump-swap')) return 'pumpswap';
  if (s.includes('pump-fun') || s.includes('pumpfun') || s === 'pump') return 'pumpfun';
  if (s.includes('raydium')) return 'raydium';
  if (s.includes('meteora')) return 'meteora';
  if (s.includes('orca')) return 'orca';
  return null;
}

function mintFromId(id: string | undefined): string | null {
  if (!id || !id.startsWith('solana_')) return null;
  const mint = id.slice('solana_'.length);
  return isLikelyPubkey(mint) ? mint : null;
}

function numOrUndef(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function isLikelyPubkey(s: string): boolean {
  return s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}
