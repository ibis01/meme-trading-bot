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
  /**
   * Claim-based idempotency (audit fix #5): acquire the EXCLUSIVE right to
   * run the debate for (signalId, mode). 'acquired=false' means another
   * worker holds a live lease — the caller must skip without spending.
   * Expired leases (crashed workers) are stolen atomically inside the
   * store. Returns a token that MUST be passed to releaseClaim.
   */
  tryClaim(
    signalId: string,
    mode: DebateMode,
    leaseMs: number,
    nowMs: number,
  ): Promise<{ acquired: boolean; token: string | null }>;
  /** Release our own claim after the verdict row is persisted. Non-owning
   * tokens are ignored. */
  releaseClaim(signalId: string, mode: DebateMode, token: string): Promise<boolean>;
}

export class InMemoryDebateStore implements DebateVerdictStore {
  private readonly rows = new Map<string, DebateVerdictRow>();
  private readonly claims = new Map<string, { ownerId: string; expiresAt: number }>();

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

  async tryClaim(
    signalId: string,
    mode: DebateMode,
    leaseMs: number,
    nowMs: number,
  ): Promise<{ acquired: boolean; token: string | null }> {
    const k = this.key(signalId, mode);
    const existing = this.claims.get(k);
    if (existing && existing.expiresAt > nowMs) {
      return { acquired: false, token: null };
    }
    // Fresh claim or atomic steal of an expired lease.
    const token = randomUUID();
    this.claims.set(k, { ownerId: token, expiresAt: nowMs + leaseMs });
    return { acquired: true, token };
  }

  async releaseClaim(signalId: string, mode: DebateMode, token: string): Promise<boolean> {
    const k = this.key(signalId, mode);
    const claim = this.claims.get(k);
    if (!claim || claim.ownerId !== token) return false;
    this.claims.delete(k);
    return true;
  }

  /** Test hook: number of live claims. */
  claimCount(): number {
    return this.claims.size;
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

  async tryClaim(
    signalId: string,
    mode: DebateMode,
    leaseMs: number,
    _nowMs: number,
  ): Promise<{ acquired: boolean; token: string | null }> {
    // Single atomic round trip: try INSERT; on conflict try to steal an
    // EXPIRED lease. A fresh lease is never visible to the steal CTE's
    // snapshot, so a live holder can never be raced out of its claim.
    const res = await this.pool.query(
      `WITH ins AS (
         INSERT INTO debate_claims (signal_id, mode, owner_id, lease_expires_at)
         VALUES ($1, $2, gen_random_uuid(), NOW() + make_interval(secs => $3::double precision / 1000.0))
         ON CONFLICT (signal_id, mode) DO NOTHING
         RETURNING owner_id
       ), steal AS (
         UPDATE debate_claims
            SET owner_id = gen_random_uuid(),
                claimed_at = NOW(),
                lease_expires_at = NOW() + make_interval(secs => $3::double precision / 1000.0)
          WHERE signal_id = $1
            AND mode = $2
            AND lease_expires_at < NOW()
         RETURNING owner_id
       )
       SELECT owner_id FROM ins
       UNION ALL
       SELECT owner_id FROM steal
       LIMIT 1`,
      [signalId, mode, leaseMs],
    );
    const ownerId = res.rows.length > 0 ? String(res.rows[0].owner_id) : null;
    return { acquired: ownerId !== null, token: ownerId };
  }

  async releaseClaim(signalId: string, mode: DebateMode, token: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM debate_claims WHERE signal_id = $1 AND mode = $2 AND owner_id = $3::uuid`,
      [signalId, mode, token],
    );
    return res.rowCount != null && res.rowCount > 0;
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
