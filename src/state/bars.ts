import { Pool } from 'pg';
import { PriceBar } from '../backtest/types';

export interface BarStore {
  save(bar: PriceBar): Promise<void>;
  saveMany(bars: PriceBar[]): Promise<void>;
  get(tokenMint: string, fromMs: number, toMs: number): Promise<PriceBar[]>;
}

export class InMemoryBarStore implements BarStore {
  private readonly rows: PriceBar[] = [];
  async save(bar: PriceBar): Promise<void> { await this.saveMany([bar]); }
  async saveMany(bars: PriceBar[]): Promise<void> {
    for (const b of bars) {
      if (!this.rows.some((r) => r.tokenMint === b.tokenMint && r.fetchedAt === b.fetchedAt)) {
        this.rows.push(b);
      }
    }
  }
  async get(tokenMint: string, fromMs: number, toMs: number): Promise<PriceBar[]> {
    return this.rows
      .filter((r) => r.tokenMint === tokenMint && r.fetchedAt >= fromMs && r.fetchedAt < toMs)
      .sort((a, b) => a.fetchedAt - b.fetchedAt);
  }
}

export class PostgresBarStore implements BarStore {
  constructor(private readonly pool: Pool) {}

  async save(bar: PriceBar): Promise<void> { await this.saveMany([bar]); }

  async saveMany(bars: PriceBar[]): Promise<void> {
    if (bars.length === 0) return;

    // Postgres allows at most 65,535 bind parameters per statement.
    // Each bar contributes 10 params → 1,000 rows = 10,000 params, safe.
    const CHUNK_SIZE = 1000;

    for (let start = 0; start < bars.length; start += CHUNK_SIZE) {
      const chunk = bars.slice(start, start + CHUNK_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];

      chunk.forEach((b, i) => {
        const base = i * 10;
        placeholders.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`,
        );
        values.push(
          b.tokenMint, b.fetchedAt, b.priceUsd, b.liquidityUsd, b.volume24hUsd,
          b.holderCount, b.top10HolderPercent, b.smartWalletNetFlowUsd ?? null,
          b.priceChange5mPercent, b.priceChange1hPercent,
        );
      });

      await this.pool.query(
        `INSERT INTO price_bars
          (token_mint, bucket_ms, price_usd, liquidity_usd, volume_24h_usd,
           holder_count, top10_holder_percent, smart_wallet_net_flow_usd,
           price_change_5m_percent, price_change_1h_percent)
         VALUES ${placeholders.join(',')}
         ON CONFLICT (token_mint, bucket_ms) DO NOTHING`,
        values,
      );
    }
  }

  async get(tokenMint: string, fromMs: number, toMs: number): Promise<PriceBar[]> {
    const res = await this.pool.query(
      `SELECT * FROM price_bars
       WHERE token_mint = $1 AND bucket_ms >= $2 AND bucket_ms < $3
       ORDER BY bucket_ms ASC`,
      [tokenMint, fromMs, toMs],
    );
    // nextPriceUsd is filled by the caller (or by the backtest CLI) from the next row.
    const bars: PriceBar[] = res.rows.map((r) => ({
      tokenMint: r.token_mint,
      fetchedAt: Number(r.bucket_ms),
      priceUsd: Number(r.price_usd),
      nextPriceUsd: 0,
      liquidityUsd: Number(r.liquidity_usd),
      volume24hUsd: Number(r.volume_24h_usd),
      holderCount: Number(r.holder_count),
      top10HolderPercent: Number(r.top10_holder_percent),
      smartWalletNetFlowUsd: r.smart_wallet_net_flow_usd === null ? undefined : Number(r.smart_wallet_net_flow_usd),
      priceChange5mPercent: Number(r.price_change_5m_percent),
      priceChange1hPercent: Number(r.price_change_1h_percent),
    }));
    return linkNextPrices(bars);
  }
}

/** Fill nextPriceUsd from the following bar. Last bar has no next price (skipped by backtester). */
export function linkNextPrices(bars: PriceBar[]): PriceBar[] {
  return bars.map((b, i) => ({
    ...b,
    nextPriceUsd: i < bars.length - 1 ? bars[i + 1].priceUsd : 0,
  }));
}
