import { Pool } from 'pg';
import { config } from '../config';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    if (!config.DATABASE_URL) {
      throw new Error('DATABASE_URL is not configured. Cannot connect to Postgres.');
    }
    pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
