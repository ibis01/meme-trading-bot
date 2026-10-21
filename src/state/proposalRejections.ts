import { randomUUID } from 'crypto';
import { Pool } from 'pg';

export interface RejectionInput {
  tradeRequestId: string;
  tokenMint: string;
  strategy: string;
  strategyVersion: string;
  reasonCode: string;
  evidence: Record<string, unknown>;
}

export interface RejectionStore {
  saveRejection(input: RejectionInput): Promise<void>;
}

export class PostgresRejectionStore implements RejectionStore {
  constructor(private readonly pool: Pool) {}

  async saveRejection(input: RejectionInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO proposal_rejections
         (id, trade_request_id, token_mint, strategy, strategy_version, reason_code, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (trade_request_id) DO NOTHING`,
      [
        randomUUID(),
        input.tradeRequestId,
        input.tokenMint,
        input.strategy,
        input.strategyVersion,
        input.reasonCode,
        JSON.stringify(input.evidence),
      ],
    );
  }
}
