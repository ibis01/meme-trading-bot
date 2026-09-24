import { Pool } from 'pg';
import { PositionStore } from './positions';

/**
 * Postgres-backed position count. Atomic UPDATE with GREATEST(0, …)
 * so we never go negative even under concurrent decrements.
 * Single-row table id=1 (seeded by migration 002).
 */
export class PostgresPositionStore implements PositionStore {
  constructor(private readonly pool: Pool) {}

  async getOpenCount(): Promise<number> {
    const res = await this.pool.query<{ open_positions: number }>(
      'SELECT open_positions FROM portfolio_state WHERE id = 1',
    );
    return res.rows.length ? Number(res.rows[0].open_positions) : 0;
  }

  async increment(): Promise<number> {
    const res = await this.pool.query<{ open_positions: number }>(
      `UPDATE portfolio_state
         SET open_positions = open_positions + 1,
             updated_at = NOW()
       WHERE id = 1
       RETURNING open_positions`,
    );
    return Number(res.rows[0].open_positions);
  }

  async decrement(): Promise<number> {
    const res = await this.pool.query<{ open_positions: number }>(
      `UPDATE portfolio_state
         SET open_positions = GREATEST(0, open_positions - 1),
             updated_at = NOW()
       WHERE id = 1
       RETURNING open_positions`,
    );
    return Number(res.rows[0].open_positions);
  }
}
