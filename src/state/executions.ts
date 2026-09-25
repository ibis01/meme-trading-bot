import { Pool } from 'pg';

export type ExecutionStatus = 'SUBMITTED' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED';

export interface StoredExecution {
  id: string;
  proposalId: string;
  tradeRequestId: string;
  txSignature: string | null;
  status: ExecutionStatus;
  error?: string;
  executedAt: number;
}

export interface ExecutionStore {
  save(e: StoredExecution): Promise<void>;
  getByRequestId(tradeRequestId: string): Promise<StoredExecution | null>;
  getBySignature(txSignature: string): Promise<StoredExecution | null>;
  updateStatus(id: string, status: ExecutionStatus, error?: string): Promise<void>;
  /** P1-7: executions that need reconciliation. */
  listUnresolved(limit: number): Promise<StoredExecution[]>;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly byId = new Map<string, StoredExecution>();
  private readonly byRequest = new Map<string, string>();
  private readonly bySignature = new Map<string, string>();

  async save(e: StoredExecution): Promise<void> {
    // Rule 24: tx_signature uniqueness — refuse duplicates silently
    if (e.txSignature && this.bySignature.has(e.txSignature)) return;
    this.byId.set(e.id, e);
    this.byRequest.set(e.tradeRequestId, e.id);
    if (e.txSignature) this.bySignature.set(e.txSignature, e.id);
  }

  async getByRequestId(tradeRequestId: string): Promise<StoredExecution | null> {
    const id = this.byRequest.get(tradeRequestId);
    return id ? this.byId.get(id) ?? null : null;
  }

  async getBySignature(txSignature: string): Promise<StoredExecution | null> {
    const id = this.bySignature.get(txSignature);
    return id ? this.byId.get(id) ?? null : null;
  }

  async updateStatus(id: string, status: ExecutionStatus, error?: string): Promise<void> {
    const e = this.byId.get(id);
    if (e) this.byId.set(id, { ...e, status, error });
  }

  async listUnresolved(limit: number): Promise<StoredExecution[]> {
    return [...this.byId.values()]
      .filter((e) => e.status === 'SUBMITTED' || e.status === 'UNKNOWN')
      .slice(0, limit);
  }
}

interface ExecutionRow {
  id: string;
  proposal_id: string;
  trade_request_id: string;
  tx_signature: string | null;
  status: ExecutionStatus;
  error: string | null;
  executed_at: Date;
}

export class PostgresExecutionStore implements ExecutionStore {
  constructor(private readonly pool: Pool) {}

  async save(e: StoredExecution): Promise<void> {
    await this.pool.query(
      `INSERT INTO executions (id, proposal_id, trade_request_id, tx_signature, status, error, executed_at)
       VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0))
       ON CONFLICT (tx_signature) DO NOTHING`,
      [e.id, e.proposalId, e.tradeRequestId, e.txSignature, e.status, e.error ?? null, e.executedAt],
    );
  }

  async getByRequestId(tradeRequestId: string): Promise<StoredExecution | null> {
    const res = await this.pool.query('SELECT * FROM executions WHERE trade_request_id = $1 LIMIT 1', [tradeRequestId]);
    return res.rows.length ? this.row(res.rows[0]) : null;
  }

  async getBySignature(txSignature: string): Promise<StoredExecution | null> {
    const res = await this.pool.query('SELECT * FROM executions WHERE tx_signature = $1', [txSignature]);
    return res.rows.length ? this.row(res.rows[0]) : null;
  }

  async updateStatus(id: string, status: ExecutionStatus, error?: string): Promise<void> {
    await this.pool.query('UPDATE executions SET status = $1, error = $2 WHERE id = $3', [status, error ?? null, id]);
  }

  async listUnresolved(limit: number): Promise<StoredExecution[]> {
    const res = await this.pool.query(
      "SELECT * FROM executions WHERE status IN ('SUBMITTED','UNKNOWN') ORDER BY executed_at ASC LIMIT $1",
      [limit],
    );
    return res.rows.map((r) => this.row(r));
  }

  private row(r: ExecutionRow): StoredExecution {
    return {
      id: r.id,
      proposalId: r.proposal_id,
      tradeRequestId: r.trade_request_id,
      txSignature: r.tx_signature,
      status: r.status,
      error: r.error ?? undefined,
      executedAt: r.executed_at.getTime(),
    };
  }
}
