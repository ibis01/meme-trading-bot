import { Pool } from 'pg';

export interface PnlStore {
  getToday(): Promise<number>;
  addSol(delta: number): Promise<number>;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export class InMemoryPnlStore implements PnlStore {
  private store = new Map<string, number>();
  async getToday(): Promise<number> {
    return this.store.get(todayUtc()) ?? 0;
  }
  async addSol(delta: number): Promise<number> {
    const key = todayUtc();
    const next = (this.store.get(key) ?? 0) + delta;
    this.store.set(key, next);
    return next;
  }
}

export class PostgresPnlStore implements PnlStore {
  constructor(private readonly pool: Pool) {}

  async getToday(): Promise<number> {
    const res = await this.pool.query<{ realized_pnl_sol: string }>(
      'SELECT realized_pnl_sol FROM daily_pnl WHERE date = $1',
      [todayUtc()],
    );
    return res.rows.length ? Number(res.rows[0].realized_pnl_sol) : 0;
  }

  async addSol(delta: number): Promise<number> {
    const res = await this.pool.query<{ realized_pnl_sol: string }>(
      `INSERT INTO daily_pnl (date, realized_pnl_sol)
       VALUES ($1, $2)
       ON CONFLICT (date)
       DO UPDATE SET realized_pnl_sol = daily_pnl.realized_pnl_sol + $2,
                     updated_at = NOW()
       RETURNING realized_pnl_sol`,
      [todayUtc(), delta],
    );
    return Number(res.rows[0].realized_pnl_sol);
  }
}
