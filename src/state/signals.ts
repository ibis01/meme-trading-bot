import { Pool } from 'pg';
import { Signal } from '../strategy/types';

export interface SignalStore {
  save(signal: Signal): Promise<void>;
  getById(id: string): Promise<Signal | null>;
  listRecent(limit: number): Promise<Signal[]>;
}

/** In-memory, used by tests and paper-trading scenarios. */
export class InMemorySignalStore implements SignalStore {
  private readonly byId = new Map<string, Signal>();
  private readonly order: string[] = [];

  async save(signal: Signal): Promise<void> {
    if (!this.byId.has(signal.id)) this.order.push(signal.id);
    this.byId.set(signal.id, signal);
  }

  async getById(id: string): Promise<Signal | null> {
    return this.byId.get(id) ?? null;
  }

  async listRecent(limit: number): Promise<Signal[]> {
    return this.order
      .slice(-limit)
      .reverse()
      .map((id) => this.byId.get(id)!)
      .filter(Boolean);
  }
}

/**
 * Postgres-backed store.
 * Rule 20: signals reference a known token. If the token is new, we register
 * it (ON CONFLICT DO NOTHING) before writing the signal, preserving the FK
 * while allowing first-sight registration.
 */
export class PostgresSignalStore implements SignalStore {
  constructor(private readonly pool: Pool) {}

  async save(signal: Signal): Promise<void> {
    // Rule 20: register token on first sight.
    await this.pool.query(
      `INSERT INTO tokens (mint) VALUES ($1) ON CONFLICT (mint) DO NOTHING`,
      [signal.tokenMint],
    );

    await this.pool.query(
      `INSERT INTO signals (id, token_mint, strategy, strategy_version, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [
        signal.id,
        signal.tokenMint,
        signal.strategy,
        signal.strategyVersion,
        JSON.stringify(signal),
      ],
    );
  }

  async getById(id: string): Promise<Signal | null> {
    const res = await this.pool.query<{ payload: Signal }>(
      'SELECT payload FROM signals WHERE id = $1',
      [id],
    );
    return res.rows.length ? res.rows[0].payload : null;
  }

  async listRecent(limit: number): Promise<Signal[]> {
    const res = await this.pool.query<{ payload: Signal }>(
      'SELECT payload FROM signals ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return res.rows.map((r) => r.payload);
  }
}
