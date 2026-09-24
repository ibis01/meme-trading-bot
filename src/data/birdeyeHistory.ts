import { HistoryProvider } from './history';
import { PriceBar } from '../backtest/types';
import { logger } from '../utils/logger';

const INTERVAL_TYPE_MAP: Record<number, string> = {
  60_000: '1m',
  300_000: '5m',
  900_000: '15m',
  3_600_000: '1h',
  14_400_000: '4h',
  86_400_000: '1d',
};

export interface BirdeyeHistoryOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Delay between paginated calls to respect Birdeye rate limits. */
  interRequestDelayMs?: number;
  /** Max candles per request (Birdeye caps around 1000). */
  maxItemsPerRequest?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  maxAttempts: number = 5,
): Promise<Response> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const res = await fetchImpl(url, init);
      if (res.status !== 429) return res;
      // Retry-After is in seconds when present.
      const retryAfter = Number((res.headers as Headers | undefined)?.get?.('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 1500 * attempt * attempt);
      await sleep(waitMs);
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(15_000, 1000 * attempt * attempt));
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`Retries exhausted after ${maxAttempts} attempts: ${url}`);
}

/**
 * Fetches historical OHLCV bars from Birdeye and enriches them with the
 * latest token_overview snapshot for static fields (liquidity/holders/volume).
 *
 * VERIFY BEFORE RELYING (Rule 30):
 *   https://docs.birdeye.so/reference/get-defi-ohlcv
 * Confirmed as of writing: `data.items[].unixTime` (seconds) and `.c` (close).
 * If Birdeye changes the shape, this provider logs and returns [].
 *
 * Note: liquidity, holders, and 24h volume are constant across the backfilled
 * range (latest snapshot). Documented in the returned log event.
 */
export class BirdeyeHistoryProvider implements HistoryProvider {
  readonly name = 'birdeye-history';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly delayMs: number;
  private readonly maxItems: number;

  constructor(private readonly opts: BirdeyeHistoryOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://public-api.birdeye.so';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.delayMs = opts.interRequestDelayMs ?? 2500;
    this.maxItems = opts.maxItemsPerRequest ?? 1000;
  }

  async fetchBars(
    tokenMint: string,
    fromMs: number,
    toMs: number,
    intervalMs: number,
  ): Promise<PriceBar[]> {
    const type = INTERVAL_TYPE_MAP[intervalMs];
    if (!type) {
      logger.error({ intervalMs }, 'Unsupported interval for Birdeye history');
      return [];
    }

    const overview = await this.fetchOverview(tokenMint);

    const raw: Array<{ ts: number; close: number }> = [];
    let cursor = fromMs;
    let pages = 0;
    while (cursor < toMs) {
      const windowEnd = Math.min(cursor + this.maxItems * intervalMs, toMs);
      const chunk = await this.fetchOhlcvPage(tokenMint, type, cursor, windowEnd);
      pages += 1;
      if (chunk.length === 0) break;
      raw.push(...chunk);
      cursor = windowEnd;
      if (cursor < toMs) await sleep(this.delayMs);
    }

    if (raw.length === 0) {
      logger.warn({ event: 'BACKFILL_EMPTY', token: tokenMint, pages }, 'No OHLCV data returned');
      return [];
    }

    raw.sort((a, b) => a.ts - b.ts);

    const prices = raw.map((b) => b.close);
    const lookback5m = Math.max(1, Math.round(5 * 60_000 / intervalMs));
    const lookback1h = Math.max(1, Math.round(60 * 60_000 / intervalMs));

    const bars: PriceBar[] = [];
    for (let i = 0; i < raw.length; i++) {
      const { ts, close } = raw[i];
      if (!Number.isFinite(close) || close <= 0) continue;
      bars.push({
        tokenMint,
        fetchedAt: ts,
        priceUsd: close,
        nextPriceUsd: 0, // linkNextPrices fills on read
        liquidityUsd: overview?.liquidityUsd ?? 0,
        volume24hUsd: overview?.volume24hUsd ?? 0,
        holderCount: overview?.holderCount ?? 0,
        top10HolderPercent: overview?.top10HolderPercent ?? 0,
        // smartWalletNetFlowUsd left undefined — Birdeye doesn't expose it
        priceChange5mPercent: pctChange(prices, i, lookback5m),
        priceChange1hPercent: pctChange(prices, i, lookback1h),
      });
    }

    logger.info(
      {
        event: 'BACKFILL_FETCHED',
        token: tokenMint,
        bars: bars.length,
        pages,
        intervalType: type,
        enrichment: overview ? 'applied' : 'missing',
      },
      'Historical bars fetched from Birdeye',
    );

    return bars;
  }

  private async fetchOverview(tokenMint: string): Promise<{
    liquidityUsd: number;
    volume24hUsd: number;
    holderCount: number;
    top10HolderPercent: number;
  } | null> {
    try {
      const url = `${this.baseUrl}/defi/token_overview?address=${encodeURIComponent(tokenMint)}`;
      const res = await fetchWithRetry(this.fetchImpl, url, {
        headers: { 'X-API-KEY': this.opts.apiKey, accept: 'application/json', 'x-chain': 'solana' },
      });
      if (!res.ok) {
        const body = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
        logger.warn(
          { event: 'OVERVIEW_HTTP_ERROR', token: tokenMint, status: res.status, body: body.slice(0, 300) },
          'Birdeye token_overview failed',
        );
        return null;
      }
      const json = (await res.json()) as { data?: Record<string, unknown> };
      const d = json.data;
      if (!d) return null;
      return {
        liquidityUsd: numOrZero(d.liquidity),
        volume24hUsd: numOrZero(d.v24hUSD),
        holderCount: intOrZero(d.holder),
        top10HolderPercent: 0,
      };
    } catch {
      return null;
    }
  }

  private async fetchOhlcvPage(
    tokenMint: string,
    type: string,
    fromMs: number,
    toMs: number,
  ): Promise<Array<{ ts: number; close: number }>> {
    try {
      const fromSec = Math.floor(fromMs / 1000);
      const toSec = Math.floor(toMs / 1000);
      const url = `${this.baseUrl}/defi/ohlcv?address=${encodeURIComponent(tokenMint)}&type=${type}&time_from=${fromSec}&time_to=${toSec}`;
      const res = await fetchWithRetry(this.fetchImpl, url, {
        headers: { 'X-API-KEY': this.opts.apiKey, accept: 'application/json', 'x-chain': 'solana' },
      });
      if (!res.ok) {
        const body = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
        logger.warn(
          { event: 'OHLCV_HTTP_ERROR', token: tokenMint, status: res.status, body: body.slice(0, 300), fromSec, toSec },
          'Birdeye OHLCV request failed',
        );
        return [];
      }
      const json = (await res.json()) as { data?: { items?: Array<Record<string, unknown>> } };
      const items = json.data?.items ?? [];
      const out: Array<{ ts: number; close: number }> = [];
      for (const item of items) {
        const ts = numOrNull(item.unixTime);
        const close = numOrNull(item.c);
        if (ts === null || close === null) continue;
        out.push({ ts: ts * 1000, close });
      }
      return out;
    } catch (err) {
      logger.error({ event: 'OHLCV_FETCH_ERROR', token: tokenMint, err }, 'Birdeye OHLCV threw');
      return [];
    }
  }
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function numOrZero(v: unknown): number {
  return numOrNull(v) ?? 0;
}
function intOrZero(v: unknown): number {
  const n = numOrNull(v);
  return n !== null && Number.isInteger(n) ? n : 0;
}
function pctChange(prices: number[], i: number, lookback: number): number {
  const from = Math.max(0, i - lookback);
  if (i === from) return 0;
  const base = prices[from];
  if (base === 0) return 0;
  return ((prices[i] - base) / base) * 100;
}
