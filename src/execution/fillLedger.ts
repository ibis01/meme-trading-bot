import { Pool } from 'pg';
import {
  CloseResult,
  OpenPositionInput,
  ClosePositionInput,
  PositionLedger,
} from '../state/positions/types';
import { PnlStore } from '../state/dailyPnl';
import { ExecutionStore } from '../state/executions';
import { logger } from '../utils/logger';

/**
 * Audit C1/C2/C3 (2026-11-24): THE canonical fill booking service.
 *
 * Every confirmed fill — whether learned immediately (executor) or late
 * (reconciliation runner) — is booked through this interface. Implementations
 * guarantee:
 *
 *  1. Idempotency: booking the same execution (or the same tx signature)
 *     twice never creates a second position fill or double-counts PnL.
 *  2. Atomicity: position update + fill insert + PnL + reconciliation status
 *     commit together or not at all.
 *  3. Invariants: quantities positive, SELL ≤ recorded holdings (never
 *     silently clamped), signature/request-id uniqueness.
 *  4. Observability: every attempt leaves a durable ledger_reconciliation
 *     row; unbooked fills surface in the repair queue and BLOCK new BUYs.
 */

export type BookingSource = 'IMMEDIATE' | 'RECONCILED';

export interface BookFillInput {
  executionId: string;
  proposalId: string;
  tradeRequestId: string;
  side: 'BUY' | 'SELL';
  tokenMint: string;
  txSignature: string;
  filledTokenAmount: number;
  filledAmountSol: number;
  source: BookingSource;
}

export type BookFillResult =
  | { kind: 'BOOKED'; fillId?: string; realizedPnlSol?: number }
  | { kind: 'ALREADY_BOOKED' }
  | { kind: 'UNRECONCILABLE'; reason: string }
  | { kind: 'QUEUED'; error: string };

export interface LedgerHealth {
  healthy: boolean;
  /** Number of fills awaiting booking / failed / unrepairable. */
  unresolved: number;
  detail?: string;
}

export interface RepairCandidate {
  executionId: string;
  proposalId: string;
  tradeRequestId: string;
  txSignature: string;
}

export interface FillLedger {
  bookFill(input: BookFillInput): Promise<BookFillResult>;
  /** Fail-closed gate: new BUYs are rejected while this is unhealthy. */
  isLedgerHealthy(): Promise<LedgerHealth>;
  /** CONFIRMED executions whose fill never got booked (crash gaps). */
  listRepairCandidates(limit: number): Promise<RepairCandidate[]>;
  /** Record that a confirmed execution can never be booked as-is. */
  markUnbookable(
    executionId: string,
    txSignature: string | null,
    source: BookingSource,
    error: string,
  ): Promise<void>;
}

// ── In-memory implementation (unit tests / dev without a database) ──────

interface MemoryStatus {
  bookingStatus: 'PENDING' | 'BOOKED' | 'FAILED' | 'UNRECONCILABLE';
  source: BookingSource;
  attempts: number;
  lastError?: string;
}

export class InMemoryFillLedger implements FillLedger {
  private readonly statusByExec = new Map<string, MemoryStatus>();
  private readonly signatures = new Set<string>();
  private readonly fillByExec = new Map<string, string>();
  private fillSeq = 0;

  constructor(
    private readonly positions: PositionLedger,
    private readonly pnl: PnlStore,
    private readonly executions?: ExecutionStore,
  ) {}

  async bookFill(input: BookFillInput): Promise<BookFillResult> {
    const existing = this.statusByExec.get(input.executionId);
    if (existing?.bookingStatus === 'BOOKED') return { kind: 'ALREADY_BOOKED' };
    if (this.signatures.has(input.txSignature)) {
      this.statusByExec.set(input.executionId, {
        bookingStatus: 'BOOKED',
        source: input.source,
        attempts: (existing?.attempts ?? 0) + 1,
      });
      return { kind: 'ALREADY_BOOKED' };
    }

    if (
      !Number.isFinite(input.filledTokenAmount) ||
      input.filledTokenAmount <= 0 ||
      !Number.isFinite(input.filledAmountSol) ||
      input.filledAmountSol <= 0
    ) {
      this.statusByExec.set(input.executionId, {
        bookingStatus: 'UNRECONCILABLE',
        source: input.source,
        attempts: (existing?.attempts ?? 0) + 1,
        lastError: 'UNUSABLE_FILL_AMOUNTS',
      });
      return { kind: 'UNRECONCILABLE', reason: 'UNUSABLE_FILL_AMOUNTS' };
    }

    const priceSol = input.filledAmountSol / input.filledTokenAmount;
    let fillId: string;
    let realizedPnlSol: number | undefined;

    if (input.side === 'BUY') {
      const openInput: OpenPositionInput = {
        tokenMint: input.tokenMint,
        tradeRequestId: input.tradeRequestId,
        quantity: input.filledTokenAmount,
        priceSol,
        signature: input.txSignature,
      };
      await this.positions.open(openInput);
      fillId = `fill_${++this.fillSeq}`;
      this.fillByExec.set(input.executionId, fillId);
    } else {
      const held = await this.positions.get(input.tokenMint);
      if (!held || held.quantity <= 0) {
        this.statusByExec.set(input.executionId, {
          bookingStatus: 'UNRECONCILABLE',
          source: input.source,
          attempts: (existing?.attempts ?? 0) + 1,
          lastError: 'SELL_NO_POSITION',
        });
        return { kind: 'UNRECONCILABLE', reason: 'SELL_NO_POSITION' };
      }
      if (input.filledTokenAmount > held.quantity) {
        this.statusByExec.set(input.executionId, {
          bookingStatus: 'UNRECONCILABLE',
          source: input.source,
          attempts: (existing?.attempts ?? 0) + 1,
          lastError: 'SELL_EXCEEDS_HOLDINGS',
        });
        return { kind: 'UNRECONCILABLE', reason: 'SELL_EXCEEDS_HOLDINGS' };
      }
      const closeInput: ClosePositionInput = {
        tokenMint: input.tokenMint,
        tradeRequestId: input.tradeRequestId,
        quantity: input.filledTokenAmount,
        priceSol,
        signature: input.txSignature,
      };
      const closeResult: CloseResult = await this.positions.close(closeInput);
      await this.pnl.addSol(closeResult.realizedPnlSol);
      realizedPnlSol = closeResult.realizedPnlSol;
      fillId = `fill_${++this.fillSeq}`;
      this.fillByExec.set(input.executionId, fillId);
    }

    this.signatures.add(input.txSignature);
    this.statusByExec.set(input.executionId, {
      bookingStatus: 'BOOKED',
      source: input.source,
      attempts: (existing?.attempts ?? 0) + 1,
    });
    return { kind: 'BOOKED', fillId, realizedPnlSol };
  }

  async isLedgerHealthy(): Promise<LedgerHealth> {
    let unresolved = 0;
    for (const s of this.statusByExec.values()) {
      if (s.bookingStatus !== 'BOOKED') unresolved += 1;
    }
    // Confirmed executions with no status row at all (crash gap).
    if (this.executions) {
      for (const exec of await this.executions.listConfirmed(1_000_000)) {
        if (exec.txSignature && !this.statusByExec.has(exec.id)) unresolved += 1;
      }
    }
    return {
      healthy: unresolved === 0,
      unresolved,
      detail: unresolved > 0 ? 'UNBOOKED_FILLS_PRESENT' : undefined,
    };
  }

  async listRepairCandidates(limit: number): Promise<RepairCandidate[]> {
    if (!this.executions) return [];
    const out: RepairCandidate[] = [];
    for (const exec of await this.executions.listConfirmed(limit)) {
      if (out.length >= limit) break;
      if (!exec.txSignature) continue;
      const s = this.statusByExec.get(exec.id);
      if (s?.bookingStatus === 'BOOKED') continue;
      out.push({
        executionId: exec.id,
        proposalId: exec.proposalId,
        tradeRequestId: exec.tradeRequestId,
        txSignature: exec.txSignature,
      });
    }
    return out;
  }

  async markUnbookable(
    executionId: string,
    txSignature: string | null,
    source: BookingSource,
    error: string,
  ): Promise<void> {
    this.statusByExec.set(executionId, {
      bookingStatus: 'UNRECONCILABLE',
      source,
      attempts: (this.statusByExec.get(executionId)?.attempts ?? 0) + 1,
      lastError: error,
    });
    if (txSignature) this.signatures.add(txSignature);
  }
}

// ── Postgres implementation (production) ────────────────────────────────

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ReconRow {
  booking_status: MemoryStatus['bookingStatus'];
  fill_id: string | null;
}

export class PostgresFillLedger implements FillLedger {
  constructor(private readonly pool: Pool) {}

  async bookFill(input: BookFillInput): Promise<BookFillResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Claim/lock the reconciliation row (idempotency anchor).
      await client.query(
        `INSERT INTO ledger_reconciliation_status
           (execution_id, tx_signature, booking_status, source)
         VALUES ($1, $2, 'PENDING', $3)
         ON CONFLICT (execution_id) DO NOTHING`,
        [input.executionId, input.txSignature, input.source],
      );
      const statusRes = await client.query<ReconRow>(
        `SELECT booking_status, fill_id FROM ledger_reconciliation_status
           WHERE execution_id = $1 FOR UPDATE`,
        [input.executionId],
      );
      if (statusRes.rows[0]?.booking_status === 'BOOKED') {
        await client.query('COMMIT');
        return { kind: 'ALREADY_BOOKED' };
      }

      // 2. Signature idempotency: one fill per tx signature, ever.
      const sigClash = await client.query(
        'SELECT id FROM position_fills WHERE signature = $1 LIMIT 1 FOR UPDATE',
        [input.txSignature],
      );
      if (sigClash.rows.length > 0) {
        await client.query(
          `UPDATE ledger_reconciliation_status
             SET booking_status = 'BOOKED', fill_id = $2, last_error = NULL,
                 attempts = attempts + 1, updated_at = NOW()
           WHERE execution_id = $1`,
          [input.executionId, sigClash.rows[0].id],
        );
        await client.query('COMMIT');
        logger.warn(
          { event: 'FILL_ALREADY_BOOKED', executionId: input.executionId, txSignature: input.txSignature },
          'Fill booking replayed for a signature that is already booked',
        );
        return { kind: 'ALREADY_BOOKED' };
      }

      // 3. Fill sanity — never book fabricated amounts.
      if (
        !Number.isFinite(input.filledTokenAmount) ||
        input.filledTokenAmount <= 0 ||
        !Number.isFinite(input.filledAmountSol) ||
        input.filledAmountSol <= 0
      ) {
        await client.query('ROLLBACK');
        await this.markUnbookable(input.executionId, input.txSignature, input.source, 'UNUSABLE_FILL_AMOUNTS');
        return { kind: 'UNRECONCILABLE', reason: 'UNUSABLE_FILL_AMOUNTS' };
      }

      const priceSol = input.filledAmountSol / input.filledTokenAmount;
      let fillId: string | undefined;
      let realizedPnlSol: number | undefined;

      if (input.side === 'BUY') {
        // 4a. BUY: average-in, replicating PostgresPositionLedger.open math
        // inside THIS transaction (atomic across fill + position + status).
        const posRes = await client.query(
          'SELECT id, quantity, avg_cost_sol FROM positions WHERE token_mint = $1 FOR UPDATE',
          [input.tokenMint],
        );
        let positionId: string;
        if (posRes.rows.length === 0) {
          const inserted = await client.query(
            `INSERT INTO positions (id, token_mint, quantity, avg_cost_sol, opened_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW())
             RETURNING id`,
            [input.tokenMint, input.filledTokenAmount, priceSol],
          );
          positionId = inserted.rows[0].id;
        } else {
          const row = posRes.rows[0];
          const existingQty = Number(row.quantity);
          const existingAvg = Number(row.avg_cost_sol);
          const newQty = existingQty + input.filledTokenAmount;
          const newAvg =
            (existingQty * existingAvg + input.filledTokenAmount * priceSol) / newQty;
          await client.query(
            `UPDATE positions
               SET quantity = $1, avg_cost_sol = $2, updated_at = NOW(), closed_at = NULL
             WHERE id = $3`,
            [newQty, newAvg, row.id],
          );
          positionId = row.id;
        }
        const fillRes = await client.query(
          `INSERT INTO position_fills
             (position_id, trade_request_id, side, quantity, price_sol, total_sol, signature)
           VALUES ($1, $2, 'BUY', $3, $4, $5, $6)
           RETURNING id`,
          [
            positionId,
            input.tradeRequestId,
            input.filledTokenAmount,
            priceSol,
            input.filledTokenAmount * priceSol,
            input.txSignature,
          ],
        );
        fillId = fillRes.rows[0].id;
      } else {
        // 4b. SELL: exact-quantity close; exceeding holdings is an invariant
        // violation (UNRECONCILABLE), never a silent clamp.
        const posRes = await client.query(
          'SELECT id, quantity, avg_cost_sol FROM positions WHERE token_mint = $1 FOR UPDATE',
          [input.tokenMint],
        );
        if (posRes.rows.length === 0 || Number(posRes.rows[0].quantity) <= 0) {
          await client.query('ROLLBACK');
          await this.markUnbookable(input.executionId, input.txSignature, input.source, 'SELL_NO_POSITION');
          return { kind: 'UNRECONCILABLE', reason: 'SELL_NO_POSITION' };
        }
        const row = posRes.rows[0];
        const heldQty = Number(row.quantity);
        const avgCost = Number(row.avg_cost_sol);
        if (input.filledTokenAmount > heldQty) {
          await client.query('ROLLBACK');
          await this.markUnbookable(
            input.executionId,
            input.txSignature,
            input.source,
            `SELL_EXCEEDS_HOLDINGS: fill=${input.filledTokenAmount} held=${heldQty}`,
          );
          return { kind: 'UNRECONCILABLE', reason: 'SELL_EXCEEDS_HOLDINGS' };
        }
        const costBasisSol = input.filledTokenAmount * avgCost;
        const proceedsSol = input.filledTokenAmount * priceSol;
        realizedPnlSol = proceedsSol - costBasisSol;
        const remaining = heldQty - input.filledTokenAmount;
        const closedAt = remaining === 0 ? new Date() : null;
        await client.query(
          `UPDATE positions
             SET quantity = $1, updated_at = NOW(), closed_at = $2
           WHERE id = $3`,
          [remaining, closedAt, row.id],
        );
        const fillRes = await client.query(
          `INSERT INTO position_fills
             (position_id, trade_request_id, side, quantity, price_sol, total_sol, signature)
           VALUES ($1, $2, 'SELL', $3, $4, $5, $6)
           RETURNING id`,
          [
            row.id,
            input.tradeRequestId,
            input.filledTokenAmount,
            priceSol,
            input.filledTokenAmount * priceSol,
            input.txSignature,
          ],
        );
        fillId = fillRes.rows[0].id;
        // Realized PnL commits in the SAME transaction as the fill.
        await client.query(
          `INSERT INTO daily_pnl (date, realized_pnl_sol)
           VALUES ($1, $2)
           ON CONFLICT (date)
           DO UPDATE SET realized_pnl_sol = daily_pnl.realized_pnl_sol + $2,
                         updated_at = NOW()`,
          [todayUtc(), realizedPnlSol],
        );
      }

      // 5. Close out the reconciliation row.
      await client.query(
        `UPDATE ledger_reconciliation_status
           SET booking_status = 'BOOKED', fill_id = $2, last_error = NULL,
               attempts = attempts + 1, updated_at = NOW()
         WHERE execution_id = $1`,
        [input.executionId, fillId],
      );

      await client.query('COMMIT');
      return { kind: 'BOOKED', fillId, realizedPnlSol };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* connection may already be gone */
      }
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort durable record of the failed attempt; if even this fails
      // (e.g. the database is down entirely) the repair sweep's LEFT JOIN
      // still discovers the CONFIRMED execution without a status row.
      try {
        await this.pool.query(
          `INSERT INTO ledger_reconciliation_status
             (execution_id, tx_signature, booking_status, source, attempts, last_error)
           VALUES ($1, $2, 'FAILED', $3, 1, $4)
           ON CONFLICT (execution_id) DO UPDATE
             SET booking_status = 'FAILED', attempts =
                   ledger_reconciliation_status.attempts + 1,
                 last_error = EXCLUDED.last_error, updated_at = NOW()`,
          [input.executionId, input.txSignature, input.source, message],
        );
      } catch (recordErr) {
        logger.error(
          { event: 'FILL_BOOKING_STATUS_RECORD_FAILED', executionId: input.executionId, recordErr },
          'Could not persist the failed booking attempt — repair sweep must find it via join scan',
        );
      }
      return { kind: 'QUEUED', error: message };
    } finally {
      client.release();
    }
  }

  async isLedgerHealthy(): Promise<LedgerHealth> {
    const res = await this.pool.query<{
      broken: string;
      pending: string;
      gap: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM ledger_reconciliation_status
           WHERE booking_status IN ('FAILED','UNRECONCILABLE'))::text AS broken,
        (SELECT COUNT(*) FROM ledger_reconciliation_status
           WHERE booking_status IN ('PENDING','FAILED'))::text AS pending,
        (SELECT COUNT(*) FROM executions e
           WHERE e.status = 'CONFIRMED'
             AND e.tx_signature IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM ledger_reconciliation_status r
               WHERE r.execution_id = e.id AND r.booking_status = 'BOOKED'
             ))::text AS gap
    `);
    const broken = Number(res.rows[0].broken);
    const pending = Number(res.rows[0].pending);
    const gap = Number(res.rows[0].gap);
    const unresolved = broken + pending + gap;
    return {
      healthy: unresolved === 0,
      unresolved,
      detail:
        unresolved > 0
          ? `broken=${broken} pending=${pending} unbookedConfirmed=${gap}`
          : undefined,
    };
  }

  async listRepairCandidates(limit: number): Promise<RepairCandidate[]> {
    const res = await this.pool.query<{
      id: string;
      proposal_id: string;
      trade_request_id: string;
      tx_signature: string;
    }>(`
      SELECT e.id, e.proposal_id, e.trade_request_id, e.tx_signature
      FROM executions e
      LEFT JOIN ledger_reconciliation_status r ON r.execution_id = e.id
      WHERE e.status = 'CONFIRMED'
        AND e.tx_signature IS NOT NULL
        AND (r.execution_id IS NULL OR r.booking_status <> 'BOOKED')
      ORDER BY e.executed_at ASC
      LIMIT $1
    `, [limit]);
    return res.rows.map((r) => ({
      executionId: r.id,
      proposalId: r.proposal_id,
      tradeRequestId: r.trade_request_id,
      txSignature: r.tx_signature,
    }));
  }

  async markUnbookable(
    executionId: string,
    txSignature: string | null,
    source: BookingSource,
    error: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO ledger_reconciliation_status
         (execution_id, tx_signature, booking_status, source, attempts, last_error)
       VALUES ($1, $2, 'UNRECONCILABLE', $3, 1, $4)
       ON CONFLICT (execution_id) DO UPDATE
         SET booking_status = 'UNRECONCILABLE',
             attempts = ledger_reconciliation_status.attempts + 1,
             last_error = EXCLUDED.last_error, updated_at = NOW()`,
      [executionId, txSignature, source, error],
    );
    logger.error(
      { event: 'FILL_UNRECONCILABLE', executionId, txSignature, error },
      'Confirmed fill cannot be booked — repair queue holds it; new BUYs are blocked',
    );
  }
}

/** Convenience: pick the implementation for the active store backend. */
export function buildFillLedger(
  storeBackend: 'postgres' | 'memory',
  opts: {
    pool?: Pool;
    positions: PositionLedger;
    pnl: PnlStore;
    executions?: ExecutionStore;
  },
): FillLedger {
  if (storeBackend === 'postgres') {
    if (!opts.pool) throw new Error('POSTGRES_FILL_LEDGER_REQUIRES_POOL');
    return new PostgresFillLedger(opts.pool);
  }
  return new InMemoryFillLedger(opts.positions, opts.pnl, opts.executions);
}
