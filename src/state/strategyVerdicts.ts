import { Pool } from 'pg';
import { WalkForwardFlag } from '../backtest/walkForward';

export interface StrategyVerdict {
  strategyName: string;
  strategyVersion: string;
  flags: WalkForwardFlag[];
  approved: boolean;
  trainReturnPct: number;
  validationReturnPct: number;
  testReturnPct: number;
  createdAt: number;
}

export interface StrategyVerdictStore {
  upsert(v: StrategyVerdict): Promise<void>;
  get(strategyName: string, strategyVersion: string): Promise<StrategyVerdict | null>;
  isApproved(strategyName: string, strategyVersion: string): Promise<boolean>;
}

export class InMemoryStrategyVerdictStore implements StrategyVerdictStore {
  private readonly map = new Map<string, StrategyVerdict>();

  private key(n: string, v: string) { return `${n}@${v}`; }

  async upsert(v: StrategyVerdict): Promise<void> {
    this.map.set(this.key(v.strategyName, v.strategyVersion), v);
  }

  async get(n: string, v: string): Promise<StrategyVerdict | null> {
    return this.map.get(this.key(n, v)) ?? null;
  }

  async isApproved(n: string, v: string): Promise<boolean> {
    return (await this.get(n, v))?.approved ?? false;
  }
}

export class PostgresStrategyVerdictStore implements StrategyVerdictStore {
  constructor(private readonly pool: Pool) {}

  async upsert(v: StrategyVerdict): Promise<void> {
    await this.pool.query(
      `INSERT INTO strategy_verdicts
         (strategy_name, strategy_version, flags, approved,
          train_return_pct, validation_return_pct, test_return_pct, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8/1000.0))
       ON CONFLICT (strategy_name, strategy_version)
       DO UPDATE SET
         flags = EXCLUDED.flags,
         approved = EXCLUDED.approved,
         train_return_pct = EXCLUDED.train_return_pct,
         validation_return_pct = EXCLUDED.validation_return_pct,
         test_return_pct = EXCLUDED.test_return_pct,
         created_at = EXCLUDED.created_at`,
      [
        v.strategyName,
        v.strategyVersion,
        v.flags,
        v.approved,
        v.trainReturnPct,
        v.validationReturnPct,
        v.testReturnPct,
        v.createdAt,
      ],
    );
  }

  async get(n: string, v: string): Promise<StrategyVerdict | null> {
    const res = await this.pool.query(
      `SELECT * FROM strategy_verdicts WHERE strategy_name = $1 AND strategy_version = $2`,
      [n, v],
    );
    if (!res.rows.length) return null;
    const r = res.rows[0];
    return {
      strategyName: r.strategy_name,
      strategyVersion: r.strategy_version,
      flags: r.flags,
      approved: r.approved,
      trainReturnPct: Number(r.train_return_pct),
      validationReturnPct: Number(r.validation_return_pct),
      testReturnPct: Number(r.test_return_pct),
      createdAt: r.created_at.getTime(),
    };
  }

  async isApproved(n: string, v: string): Promise<boolean> {
    return (await this.get(n, v))?.approved ?? false;
  }
}
