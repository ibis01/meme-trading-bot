import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import {
  ClosePositionInput,
  CloseResult,
  OpenPositionInput,
  Position,
  PositionFill,
  PositionLedger,
} from './types';

/**
 * Rule 24: open/close are transactional. We lock the position row FOR UPDATE
 * so two concurrent fills cannot race on the average-cost computation.
 */
export class PostgresPositionLedger implements PositionLedger {
  constructor(private readonly pool: Pool) {}

  async open(input: OpenPositionInput): Promise<Position> {
    validateQuantity(input.quantity);
    validatePrice(input.priceSol);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<PositionRow>(
        'SELECT * FROM positions WHERE token_mint = $1 FOR UPDATE',
        [input.tokenMint],
      );

      let updated: Position;
      if (row.rows.length === 0) {
        const inserted = await client.query<PositionRow>(
          `INSERT INTO positions (id, token_mint, quantity, avg_cost_sol, opened_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW(), NOW())
           RETURNING *`,
          [randomUUID(), input.tokenMint, input.quantity, input.priceSol],
        );
        updated = rowToPosition(inserted.rows[0]);
      } else {
        const existing = rowToPosition(row.rows[0]);
        const newQty = existing.quantity + input.quantity;
        const newAvg = (existing.quantity * existing.avgCostSol + input.quantity * input.priceSol) / newQty;
        const updatedRow = await client.query<PositionRow>(
          `UPDATE positions
             SET quantity = $1, avg_cost_sol = $2, updated_at = NOW(), closed_at = NULL
           WHERE id = $3
           RETURNING *`,
          [newQty, newAvg, existing.id],
        );
        updated = rowToPosition(updatedRow.rows[0]);
      }

      await client.query(
        `INSERT INTO position_fills
           (position_id, trade_request_id, side, quantity, price_sol, total_sol, signature)
         VALUES ($1, $2, 'BUY', $3, $4, $5, $6)`,
        [updated.id, input.tradeRequestId, input.quantity, input.priceSol, input.quantity * input.priceSol, input.signature],
      );

      await client.query('COMMIT');
      return updated;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(input: ClosePositionInput): Promise<CloseResult> {
    validateQuantity(input.quantity);
    validatePrice(input.priceSol);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<PositionRow>(
        'SELECT * FROM positions WHERE token_mint = $1 FOR UPDATE',
        [input.tokenMint],
      );
      if (row.rows.length === 0) throw new Error('NO_OPEN_POSITION');
      const existing = rowToPosition(row.rows[0]);
      if (existing.quantity <= 0) throw new Error('NO_OPEN_POSITION');
      if (input.quantity > existing.quantity) throw new Error('INSUFFICIENT_QUANTITY');

      const costBasisSol = input.quantity * existing.avgCostSol;
      const proceedsSol = input.quantity * input.priceSol;
      const realizedPnlSol = proceedsSol - costBasisSol;
      const remainingQuantity = existing.quantity - input.quantity;

      await client.query(
        `UPDATE positions
           SET quantity = $1, updated_at = NOW(),
               closed_at = CASE WHEN $1 = 0 THEN NOW() ELSE NULL END
         WHERE id = $2`,
        [remainingQuantity, existing.id],
      );

      await client.query(
        `INSERT INTO position_fills
           (position_id, trade_request_id, side, quantity, price_sol, total_sol, signature)
         VALUES ($1, $2, 'SELL', $3, $4, $5, $6)`,
        [existing.id, input.tradeRequestId, input.quantity, input.priceSol, input.quantity * input.priceSol, input.signature],
      );

      await client.query('COMMIT');
      return { costBasisSol, realizedPnlSol, remainingQuantity };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async get(tokenMint: string): Promise<Position | null> {
    const r = await this.pool.query<PositionRow>('SELECT * FROM positions WHERE token_mint = $1', [tokenMint]);
    return r.rows.length ? rowToPosition(r.rows[0]) : null;
  }

  async list(): Promise<Position[]> {
    const r = await this.pool.query<PositionRow>('SELECT * FROM positions WHERE quantity > 0 ORDER BY opened_at ASC');
    return r.rows.map(rowToPosition);
  }

  async getOpenCount(): Promise<number> {
    const r = await this.pool.query<{ c: string }>('SELECT COUNT(*)::text AS c FROM positions WHERE quantity > 0');
    return Number(r.rows[0].c);
  }

  async getFills(positionId: string): Promise<PositionFill[]> {
    const r = await this.pool.query<FillRow>(
      'SELECT * FROM position_fills WHERE position_id = $1 ORDER BY executed_at ASC',
      [positionId],
    );
    return r.rows.map(rowToFill);
  }
}

interface PositionRow {
  id: string;
  token_mint: string;
  quantity: string;
  avg_cost_sol: string;
  opened_at: Date;
  updated_at: Date;
  closed_at: Date | null;
}

interface FillRow {
  id: string;
  position_id: string;
  trade_request_id: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  price_sol: string;
  total_sol: string;
  signature: string | null;
  executed_at: Date;
}

function rowToPosition(r: PositionRow): Position {
  return {
    id: r.id,
    tokenMint: r.token_mint,
    quantity: Number(r.quantity),
    avgCostSol: Number(r.avg_cost_sol),
    openedAt: r.opened_at.getTime(),
    updatedAt: r.updated_at.getTime(),
    closedAt: r.closed_at ? r.closed_at.getTime() : undefined,
  };
}

function rowToFill(r: FillRow): PositionFill {
  return {
    id: r.id,
    positionId: r.position_id,
    tradeRequestId: r.trade_request_id,
    side: r.side,
    quantity: Number(r.quantity),
    priceSol: Number(r.price_sol),
    totalSol: Number(r.total_sol),
    signature: r.signature ?? '',
    executedAt: r.executed_at.getTime(),
  };
}

function validateQuantity(q: number): void {
  if (!Number.isFinite(q) || q <= 0) throw new Error('INVALID_QUANTITY');
}

function validatePrice(p: number): void {
  if (!Number.isFinite(p) || p <= 0) throw new Error('INVALID_PRICE');
}
