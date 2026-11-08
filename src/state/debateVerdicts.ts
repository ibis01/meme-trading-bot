import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { VerdictStance } from '../debate/schemas';

/**
 * Phase 2 persistence — debate verdict rows. Mirrors the proposalRejections.ts
 * pattern: a store interface with InMemory + Postgres implementations, so the
 * debate service is unit-testable without a database.
 *
 * Without DATABASE_URL the advisor is not constructed at all (resolveDebateMode
 * is fatal), so the Postgres store is the only one used in production. The
 * InMemory store exists for unit tests of the debate service itself.
 */

export type DebateOutcome = 'COMPLETED' | 'UNAVAILABLE' | 'INVALID';
export type DebateMode = 'shadow' | 'advise';

export interface DebateVerdictRow {
  signalId: string;
  tradeRequestId: string;
  tokenMint: string;
  mode: DebateMode;
  outcome: DebateOutcome;
  /** Present only when outcome=COMPLETED. */
  stance?: VerdictStance;
  /** Present only when outcome=COMPLETED. */
  confidence?: number;
  /** Present only when outcome=COMPLETED. */
  vetoRecommended?: boolean;
  /** Validated judge output (NULL unless COMPLETED). */
  verdict: Record<string, unknown> | null;
  /** All role messages, usage, latencies. Always present. */
  transcript: Record<string, unknown>;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  latencyMs: number;
  costUsdEst: number | null;
  createdAt: number;
}

export interface DebateVerdictStore {
  save(row: DebateVerdictRow): Promise<void>;
  /** For tests + idempotency checks. */
  getBySignal(signalId: string, mode: DebateMode): Promise<DebateVerdictRow | null>;
}

export class InMemoryDebateStore implements DebateVerdictStore {
  private readonly rows = new Map<string, DebateVerdictRow>();

  private key(signalId: string, mode: DebateMode): string {
    return `${mode}:${signalId}`;
  }

  async save(row: DebateVerdictRow): Promise<void> {
    // UNIQUE (signal_id, mode): a re-processed signal never double-writes.
    this.rows.set(this.key(row.signalId, row.mode), { ...row });
  }

  async getBySignal(
    signalId: string,
    mode: DebateMode,
  ): Promise<DebateVerdictRow | null> {
    return this.rows.get(this.key(signalId, mode)) ?? null;
  }
}

export class PostgresDebateStore implements DebateVerdictStore {
  constructor(private readonly pool: Pool) {}

  async save(row: DebateVerdictRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO debate_verdicts
         (id, signal_id, trade_request_id, token_mint, mode, outcome,
          stance, confidence, veto_recommended, verdict, transcript,
          model, prompt_version, schema_version, latency_ms, cost_usd_est,
          created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, to_timestamp($17 / 1000.0))
       ON CONFLICT (signal_id, mode) DO NOTHING`,
      [
        randomUUID(),
        row.signalId,
        row.tradeRequestId,
        row.tokenMint,
        row.mode,
        row.outcome,
        row.stance ?? null,
        row.confidence ?? null,
        row.vetoRecommended ?? null,
        row.verdict ? JSON.stringify(row.verdict) : null,
        JSON.stringify(row.transcript),
        row.model,
        row.promptVersion,
        row.schemaVersion,
        row.latencyMs,
        row.costUsdEst ?? null,
        row.createdAt,
      ],
    );
  }

  async getBySignal(
    signalId: string,
    mode: DebateMode,
  ): Promise<DebateVerdictRow | null> {
    const res = await this.pool.query(
      `SELECT * FROM debate_verdicts WHERE signal_id = $1 AND mode = $2 LIMIT 1`,
      [signalId, mode],
    );
    if (res.rows.length === 0) return null;
    return mapRow(res.rows[0]);
  }
}

function mapRow(r: Record<string, unknown>): DebateVerdictRow {
  return {
    signalId: String(r.signal_id),
    tradeRequestId: String(r.trade_request_id),
    tokenMint: String(r.token_mint),
    mode: String(r.mode) as DebateMode,
    outcome: String(r.outcome) as DebateOutcome,
    stance: r.stance == null ? undefined : (String(r.stance) as VerdictStance),
    confidence:
      r.confidence == null ? undefined : Number(r.confidence),
    vetoRecommended:
      r.veto_recommended == null ? undefined : Boolean(r.veto_recommended),
    verdict:
      r.verdict == null
        ? null
        : (r.verdict as Record<string, unknown>),
    transcript: r.transcript as Record<string, unknown>,
    model: String(r.model),
    promptVersion: String(r.prompt_version),
    schemaVersion: String(r.schema_version),
    latencyMs: Number(r.latency_ms),
    costUsdEst:
      r.cost_usd_est == null ? null : Number(r.cost_usd_est),
    createdAt: Number(r.created_at),
  };
}
