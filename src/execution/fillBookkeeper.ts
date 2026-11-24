import { Pool } from 'pg';
import { PnlStore } from '../state/dailyPnl';
import { PositionLedger } from '../state/positions/types';
import { logger } from '../utils/logger';

/**
 * Gate 1a — THE canonical fill-booking service.
 *
 * Both the immediate confirmation path (TradeExecutor on a CONFIRMED
 * outcome) and the delayed reconciliation path (ReconciliationRunner after
 * RpcReconciler resolves a SUBMITTED/UNKNOWN execution) MUST call
 * applyConfirmedFill(). There is exactly one booking implementation per
 * store backend; re-running it for the same execution (same signature) is
 * a no-op — never a second position fill, never double-counted PnL.
 *
 * Idempotency model:
 *   Postgres  — one transaction; row-lock the execution, refuse when
 *               booked_at IS NOT NULL; positions, position_fills
 *               (trade_request_id UNIQUE), daily_pnl, execution status and
 *               proposal status all commit together or not at all.
 *   InMemory  — booked-set guard around the same sequence (paper mode).
 *
 * Failure model (repair queue):
 *   If ANY step throws, the transaction rolls back: the execution stays
 *   CONFIRMED-but-unbooked (Postgres) or unclaimed (memory). Those rows ARE
 *   the persistent repair queue — countUnresolved() (see executions store)
 *   includes them, and new BUYs are blocked while the queue is non-empty.
 */

export interface FillBookingInput {
  executionId: string;
  proposalId: string;
  tradeRequestId: string;
  tokenMint: string;
  side: 'BUY' | 'SELL';
  /** SOL spent (BUY) or received (SELL). Must be > 0. */
  filledAmountSol: number;
  /** Token units (float64, for float interfaces). Must be > 0. */
  filledTokenAmount: number;
  /** EXACT raw base units when the provider could derive them (Gate 2). */
  filledTokenAmountRaw?: string;
  txSignature: string | null;
  executedAt: number;
}

export interface FillBookingResult {
  /** true when this fill had ALREADY been booked (idempotent re-run). */
  alreadyBooked: boolean;
}

export interface FillBookkeeper {
  readonly name: string;
  applyConfirmedFill(input: FillBookingInput): Promise<FillBookingResult>;
  /** CONFIRMED executions that never got booked — the persistent repair queue. */
  listPendingBookings(limit: number): Promise<Array<{ executionId: string }>>;
}

// ── shared validation ───────────────────────────────────────────────────

export function validateBookingInput(input: FillBookingInput): void {
  if (!Number.isFinite(input.filledAmountSol) || input.filledAmountSol <= 0) {
    throw new Error(`UNUSABLE_FILL_AMOUNTS(sol=${input.filledAmountSol})`);
  }
  if (!Number.isFinite(input.filledTokenAmount) || input.filledTokenAmount <= 0) {
    throw new Error(`UNUSABLE_FILL_AMOUNTS(tokens=${input.filledTokenAmount})`);
  }
  if (
    input.filledTokenAmountRaw !== undefined &&
    !/^\d+$/.test(input.filledTokenAmountRaw)
  ) {
    throw new Error('UNUSABLE_FILL_AMOUNTS(raw not a digit string)');
  }
  if (input.filledTokenAmountRaw === '0') {
    throw new Error('UNUSABLE_FILL_AMOUNTS(raw=0)');
  }
}

// ── Postgres (manual/live + postgres-backed paper) ──────────────────────

export class PostgresFillBookkeeper implements FillBookkeeper {
  readonly name = 'postgres';
  constructor(private readonly pool: Pool) {}

  async applyConfirmedFill(input: FillBookingInput): Promise<FillBookingResult> {
    validateBookingInput(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Lock the execution row. Idempotency gate: already booked → no-op.
      const execRes = await client.query<{
        id: string;
        proposal_id: string;
        trade_request_id: string;
        status: string;
        booked_at: Date | null;
      }>('SELECT id, proposal_id, trade_request_id, status, booked_at FROM executions WHERE id = $1 FOR UPDATE', [
        input.executionId,
      ]);
      if (execRes.rows.length === 0) throw new Error('EXECUTION_NOT_FOUND');
      const exec = execRes.rows[0];
      if (exec.status === 'FAILED') throw new Error('EXECUTION_ALREADY_FAILED');
      if (exec.booked_at !== null) {
        await client.query('COMMIT');
        return { alreadyBooked: true };
      }

      // 2. Lock the position row (same ordering as PostgresPositionLedger).
      const posRes = await client.query<{
        id: string;
        quantity: string;
        avg_cost_sol: string;
      }>('SELECT id, quantity, avg_cost_sol FROM positions WHERE token_mint = $1 FOR UPDATE', [
        input.tokenMint,
      ]);
      const position = posRes.rows[0] ?? null;

      // Exact quantity text (Gate 2): prefer the bigint-precise raw string.
      const qtyText = input.filledTokenAmountRaw ?? String(input.filledTokenAmount);
      const priceSol = input.filledAmountSol / input.filledTokenAmount;
      const priceText = String(priceSol);
      let realizedPnlSol = 0;

      if (input.side === 'BUY') {
        if (position && Number(position.quantity) > 0) {
          // Average in — mirrors PostgresPositionLedger.open().
          const oldQty = Number(position.quantity);
          const oldAvg = Number(position.avg_cost_sol);
          const newQty = oldQty + input.filledTokenAmount;
          const newAvg = (oldQty * oldAvg + input.filledTokenAmount * priceSol) / newQty;
          await client.query(
            'UPDATE positions SET quantity = $1, avg_cost_sol = $2, updated_at = NOW(), closed_at = NULL WHERE id = $3',
            [String(newQty), String(newAvg), position.id],
          );
        } else {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO positions (id, token_mint, quantity, avg_cost_sol, opened_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
             ON CONFLICT (token_mint) DO UPDATE
               SET quantity = EXCLUDED.quantity, avg_cost_sol = EXCLUDED.avg_cost_sol,
                   updated_at = NOW(), closed_at = NULL
             RETURNING id`,
            [input.tokenMint, qtyText, priceText],
          );
          void inserted;
        }
        await insertFill(client, input, 'BUY', qtyText, priceText);
      } else {
        // SELL — mirrors PostgresPositionLedger.close() + PnL in ONE tx.
        if (!position || Number(position.quantity) <= 0) {
          throw new Error('BOOKING_SELL_NO_POSITION');
        }
        const held = Number(position.quantity);
        const qty = Math.min(input.filledTokenAmount, held);
        const costBasisSol = qty * Number(position.avg_cost_sol);
        const proceedsSol = qty * priceSol;
        realizedPnlSol = proceedsSol - costBasisSol;
        const remaining = held - qty;
        await client.query(
          'UPDATE positions SET quantity = $1, updated_at = NOW(), closed_at = $2 WHERE id = $3',
          [String(remaining), remaining === 0 ? new Date() : null, position.id],
        );
        await insertFill(client, input, 'SELL', String(qty), priceText);
        // PnL in the SAME transaction as the fill — no crash window where
        // the position moved but the PnL did not.
        await client.query(
          `INSERT INTO daily_pnl (date, realized_pnl_sol)
           VALUES (CURRENT_DATE, $1)
           ON CONFLICT (date)
           DO UPDATE SET realized_pnl_sol = daily_pnl.realized_pnl_sol + $1, updated_at = NOW()`,
          [String(realizedPnlSol)],
        );
      }

      // 3. Mark the execution booked (status CONFIRMED + real fills).
      await client.query(
        `UPDATE executions
           SET status = 'CONFIRMED', booked_at = NOW(), error = NULL,
               filled_amount_sol = $2, filled_token_amount = $3,
               filled_token_amount_raw = $4, fill_side = $5
         WHERE id = $1`,
        [
          input.executionId,
          String(input.filledAmountSol),
          String(input.filledTokenAmount),
          input.filledTokenAmountRaw ?? null,
          input.side,
        ],
      );

      // 4. Proposal EXECUTED.
      await client.query("UPDATE trade_proposals SET status = 'EXECUTED' WHERE id = $1", [
        input.proposalId,
      ]);

      await client.query('COMMIT');
      return { alreadyBooked: false };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listPendingBookings(limit: number): Promise<Array<{ executionId: string }>> {
    const res = await this.pool.query<{ id: string }>(
      `SELECT id FROM executions
       WHERE status = 'CONFIRMED' AND booked_at IS NULL
       ORDER BY executed_at ASC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({ executionId: r.id }));
  }
}

async function insertFill(
  client: {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
  },
  input: FillBookingInput,
  side: 'BUY' | 'SELL',
  qtyText: string,
  priceText: string,
): Promise<void> {
  // position_fills.trade_request_id is UNIQUE — a second booking attempt for
  // the same trade request is a hard error, never a silent duplicate.
  await client.query(
    `INSERT INTO position_fills
       (position_id, trade_request_id, side, quantity, price_sol, total_sol, signature)
     SELECT p.id, $2, $3, $4, $5, $6, $7
       FROM positions p
      WHERE p.token_mint = $1`,
    [
      input.tokenMint,
      input.tradeRequestId,
      side,
      qtyText,
      priceText,
      String(Number(qtyText) * Number(priceText)),
      input.txSignature,
    ],
  );
}

// ── In-memory (paper mode / unit tests) ─────────────────────────────────

export class InMemoryFillBookkeeper implements FillBookkeeper {
  readonly name = 'memory';
  private readonly booked = new Set<string>();

  constructor(
    private readonly positions: PositionLedger,
    private readonly pnl: PnlStore,
  ) {}

  async applyConfirmedFill(input: FillBookingInput): Promise<FillBookingResult> {
    validateBookingInput(input);
    if (this.booked.has(input.executionId)) return { alreadyBooked: true };

    if (input.side === 'BUY') {
      await this.positions.open({
        tokenMint: input.tokenMint,
        tradeRequestId: input.tradeRequestId,
        quantity: input.filledTokenAmount,
        priceSol: input.filledAmountSol / input.filledTokenAmount,
        signature: input.txSignature ?? '',
      });
    } else {
      const held = await this.positions.get(input.tokenMint);
      if (!held || held.quantity <= 0) {
        throw new Error('BOOKING_SELL_NO_POSITION');
      }
      const qty = Math.min(input.filledTokenAmount, held.quantity);
      const closeResult = await this.positions.close({
        tokenMint: input.tokenMint,
        tradeRequestId: input.tradeRequestId,
        quantity: qty,
        priceSol: input.filledAmountSol / qty,
        signature: input.txSignature ?? '',
      });
      await this.pnl.addSol(closeResult.realizedPnlSol);
    }

    this.booked.add(input.executionId);
    return { alreadyBooked: false };
  }

  async listPendingBookings(limit: number): Promise<Array<{ executionId: string }>> {
    // In-memory bookings are applied inline; an exception leaves the
    // execution unclaimed and it stays in listUnresolved() instead.
    void limit;
    return [];
  }
}

/** Keeps the logger import referenced for structured repair events. */
void logger;
