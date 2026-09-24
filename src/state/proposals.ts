import { Pool } from 'pg';
import { TradeProposal, RiskDecision } from '../risk/types';

export type ProposalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED';

export interface StoredProposal {
  id: string;
  tradeRequestId: string;
  signalId: string;
  proposal: TradeProposal;
  decision: RiskDecision;
  status: ProposalStatus;
  createdAt: number;
}

export interface ProposalStore {
  save(p: StoredProposal): Promise<void>;
  getByRequestId(tradeRequestId: string): Promise<StoredProposal | null>;
  updateStatus(id: string, status: ProposalStatus): Promise<void>;
  listRecent(limit: number): Promise<StoredProposal[]>;
}

export class InMemoryProposalStore implements ProposalStore {
  private readonly byId = new Map<string, StoredProposal>();
  private readonly byRequest = new Map<string, string>();
  private readonly order: string[] = [];

  async save(p: StoredProposal): Promise<void> {
    if (!this.byId.has(p.id)) this.order.push(p.id);
    this.byId.set(p.id, p);
    this.byRequest.set(p.tradeRequestId, p.id);
  }

  async getByRequestId(tradeRequestId: string): Promise<StoredProposal | null> {
    const id = this.byRequest.get(tradeRequestId);
    return id ? this.byId.get(id) ?? null : null;
  }

  async updateStatus(id: string, status: ProposalStatus): Promise<void> {
    const p = this.byId.get(id);
    if (p) this.byId.set(id, { ...p, status });
  }

  async listRecent(limit: number): Promise<StoredProposal[]> {
    return this.order.slice(-limit).reverse().map((id) => this.byId.get(id)!);
  }
}

export class PostgresProposalStore implements ProposalStore {
  constructor(private readonly pool: Pool) {}

  async save(p: StoredProposal): Promise<void> {
    await this.pool.query(
      `INSERT INTO trade_proposals
         (id, trade_request_id, signal_id, token_mint, side, amount_sol, risk_decision, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9/1000.0))
       ON CONFLICT (trade_request_id) DO NOTHING`,
      [
        p.id,
        p.tradeRequestId,
        p.signalId,
        p.proposal.tokenMint,
        p.proposal.side,
        p.proposal.amountSol,
        JSON.stringify({ proposal: p.proposal, decision: p.decision }),
        p.status,
        p.createdAt,
      ],
    );
  }

  async getByRequestId(tradeRequestId: string): Promise<StoredProposal | null> {
    const res = await this.pool.query<{
      id: string; trade_request_id: string; signal_id: string;
      risk_decision: { proposal: TradeProposal; decision: RiskDecision };
      status: ProposalStatus; created_at: Date;
    }>(
      'SELECT * FROM trade_proposals WHERE trade_request_id = $1',
      [tradeRequestId],
    );
    if (!res.rows.length) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      tradeRequestId: r.trade_request_id,
      signalId: r.signal_id,
      proposal: r.risk_decision.proposal,
      decision: r.risk_decision.decision,
      status: r.status,
      createdAt: r.created_at.getTime(),
    };
  }

  async updateStatus(id: string, status: ProposalStatus): Promise<void> {
    await this.pool.query('UPDATE trade_proposals SET status = $1 WHERE id = $2', [status, id]);
  }

  async listRecent(limit: number): Promise<StoredProposal[]> {
    const res = await this.pool.query(
      'SELECT * FROM trade_proposals ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      tradeRequestId: r.trade_request_id,
      signalId: r.signal_id,
      proposal: r.risk_decision.proposal,
      decision: r.risk_decision.decision,
      status: r.status,
      createdAt: r.created_at.getTime(),
    }));
  }
}
