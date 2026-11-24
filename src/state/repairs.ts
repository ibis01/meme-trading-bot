import { randomUUID } from 'crypto';
import { Pool } from 'pg';

/**
 * Gate 1 (audit 2026-11-09): durable repair queue for fills that landed
 * on-chain but could NOT be booked into positions/PnL.
 *
 * Invariants (Rule 23, Rule 24):
 *  - Every unbookable fill creates exactly one OPEN repair per trade request
 *    (the partial unique index makes re-adds idempotent).
 *  - While any repair is OPEN the risk engine blocks new BUYs
 *    (RECONCILE_REPAIRS_PENDING). Exits (SELLs) stay available so the queue
 *    can never trap capital (same side-awareness as the kill switch).
 *  - Resolution is manual: the operator books/adjusts the ledger, then marks
 *    the repair RESOLVED with a note.
 */

export type RepairStatus = 'OPEN' | 'RESOLVED';

export interface RepairRecord {
  id: string;
  executionId?: string;
  tradeRequestId: string;
  tokenMint?: string;
  side?: 'BUY' | 'SELL';
  txSignature?: string;
  reason: string;
  detail?: string;
  status: RepairStatus;
  createdAt: number;
  resolvedAt?: number;
  resolutionNote?: string;
}

export interface NewRepairInput {
  executionId?: string;
  tradeRequestId: string;
  tokenMint?: string;
  side?: 'BUY' | 'SELL';
  txSignature?: string;
  reason: string;
  detail?: string;
}

export interface RepairStore {
  /** Idempotent: at most one OPEN repair per trade request. */
  add(input: NewRepairInput): Promise<RepairRecord>;
  listOpen(limit: number): Promise<RepairRecord[]>;
  countOpen(): Promise<number>;
  hasOpen(tradeRequestId: string): Promise<boolean>;
  resolve(id: string, note?: string): Promise<void>;
}

export class InMemoryRepairStore implements RepairStore {
  private readonly byId = new Map<string, RepairRecord>();

  async add(input: NewRepairInput): Promise<RepairRecord> {
    const existing = this.listOpenSync().find(
      (r) => r.tradeRequestId === input.tradeRequestId,
    );
    if (existing) return existing;
    const record: RepairRecord = {
      id: randomUUID(),
      executionId: input.executionId,
      tradeRequestId: input.tradeRequestId,
      tokenMint: input.tokenMint,
      side: input.side,
      txSignature: input.txSignature,
      reason: input.reason,
      detail: input.detail,
      status: 'OPEN',
      createdAt: Date.now(),
    };
    this.byId.set(record.id, record);
    return record;
  }

  async listOpen(limit: number): Promise<RepairRecord[]> {
    return this.listOpenSync().slice(0, limit);
  }

  async countOpen(): Promise<number> {
    return this.listOpenSync().length;
  }

  async hasOpen(tradeRequestId: string): Promise<boolean> {
    return this.listOpenSync().some((r) => r.tradeRequestId === tradeRequestId);
  }

  async resolve(id: string, note?: string): Promise<void> {
    const r = this.byId.get(id);
    if (r && r.status === 'OPEN') {
      this.byId.set(id, {
        ...r,
        status: 'RESOLVED',
        resolvedAt: Date.now(),
        resolutionNote: note,
      });
    }
  }

  private listOpenSync(): RepairRecord[] {
    return [...this.byId.values()]
      .filter((r) => r.status === 'OPEN')
      .sort((a, b) => a.createdAt - b.createdAt);
  }
}

interface RepairRow {
  id: string;
  execution_id: string | null;
  trade_request_id: string;
  token_mint: string | null;
  side: 'BUY' | 'SELL' | null;
  tx_signature: string | null;
  reason: string;
  detail: string | null;
  status: RepairStatus;
  created_at: Date;
  resolved_at: Date | null;
  resolution_note: string | null;
}

export class PostgresRepairStore implements RepairStore {
  constructor(private readonly pool: Pool) {}

  async add(input: NewRepairInput): Promise<RepairRecord> {
    const inserted = await this.pool.query<RepairRow>(
      `INSERT INTO reconciliation_repairs
         (execution_id, trade_request_id, token_mint, side, tx_signature, reason, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (trade_request_id) WHERE status = 'OPEN' DO NOTHING
       RETURNING *`,
      [
        input.executionId ?? null,
        input.tradeRequestId,
        input.tokenMint ?? null,
        input.side ?? null,
        input.txSignature ?? null,
        input.reason,
        input.detail ?? null,
      ],
    );
    if (inserted.rows.length > 0) return this.row(inserted.rows[0]);
    // Conflict with an existing OPEN repair — idempotent return of that row.
    const existing = await this.pool.query<RepairRow>(
      `SELECT * FROM reconciliation_repairs
        WHERE trade_request_id = $1 AND status = 'OPEN'
        ORDER BY created_at ASC LIMIT 1`,
      [input.tradeRequestId],
    );
    if (existing.rows.length === 0) {
      throw new Error('REPAIR_INSERT_FAILED_NO_ROW');
    }
    return this.row(existing.rows[0]);
  }

  async listOpen(limit: number): Promise<RepairRecord[]> {
    const res = await this.pool.query<RepairRow>(
      `SELECT * FROM reconciliation_repairs WHERE status = 'OPEN'
        ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => this.row(r));
  }

  async countOpen(): Promise<number> {
    const res = await this.pool.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM reconciliation_repairs WHERE status = 'OPEN'",
    );
    return Number(res.rows[0].c);
  }

  async hasOpen(tradeRequestId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM reconciliation_repairs
        WHERE trade_request_id = $1 AND status = 'OPEN' LIMIT 1`,
      [tradeRequestId],
    );
    return res.rows.length > 0;
  }

  async resolve(id: string, note?: string): Promise<void> {
    await this.pool.query(
      `UPDATE reconciliation_repairs
         SET status = 'RESOLVED', resolved_at = NOW(), resolution_note = $2
       WHERE id = $1 AND status = 'OPEN'`,
      [id, note ?? null],
    );
  }

  private row(r: RepairRow): RepairRecord {
    return {
      id: r.id,
      executionId: r.execution_id ?? undefined,
      tradeRequestId: r.trade_request_id,
      tokenMint: r.token_mint ?? undefined,
      side: r.side ?? undefined,
      txSignature: r.tx_signature ?? undefined,
      reason: r.reason,
      detail: r.detail ?? undefined,
      status: r.status,
      createdAt: r.created_at.getTime(),
      resolvedAt: r.resolved_at ? r.resolved_at.getTime() : undefined,
      resolutionNote: r.resolution_note ?? undefined,
    };
  }
}
