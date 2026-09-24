import { Pool } from 'pg';
import { logger } from '../utils/logger';

/**
 * Creates the meme_bot_test database if it does not exist.
 * Connects to the default `postgres` admin DB, so it does not
 * depend on meme_bot_test existing yet.
 */
async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL
    ?? 'postgresql://user:pass@localhost:5432/postgres';
  const pool = new Pool({ connectionString: adminUrl });
  try {
    await pool.query('CREATE DATABASE meme_bot_test');
    logger.info('Created database meme_bot_test');
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === '42P04') {
      logger.info('Database meme_bot_test already exists — skipping');
    } else {
      throw err;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'createTestDb failed');
  process.exit(1);
});
