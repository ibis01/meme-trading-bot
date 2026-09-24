import fs from 'fs';
import path from 'path';
import { getPool, closePool } from '../infra/db';
import { logger } from '../utils/logger';

async function main() {
  // Migrations live at repo_root/db/migrations.
  // From dist/src/scripts or src/scripts, walk up to repo root via cwd().
  const dir = path.join(process.cwd(), 'db', 'migrations');
  if (!fs.existsSync(dir)) {
    throw new Error(`Migration directory not found: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const pool = getPool();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    logger.info({ file }, 'Applying migration');
    await pool.query(sql);
  }
  await closePool();
  logger.info('Migrations complete');
}

main().catch((err) => {
  logger.fatal({ err }, 'Migration failed');
  process.exit(1);
});
