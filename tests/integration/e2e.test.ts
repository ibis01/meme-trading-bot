/**
 * Integration test against REAL Postgres + Redis.
 * Requires:
 *   docker compose -f docker/docker-compose.yml up -d postgres redis
 *   npm run db:create:test
 * Run with:
 *   npm run test:integration
 *
 * Without INTEGRATION=1, this file skips so `npm test` stays fast and hermetic.
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const RUN = process.env.INTEGRATION === '1';
const describeIf = RUN ? describe : describe.skip;

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL
  ?? 'postgresql://user:pass@localhost:5432/meme_bot_test';
const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';

// Point config at the test DB/Redis BEFORE any src module loads.
process.env.DATABASE_URL = TEST_DB_URL;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.TRADING_MODE = 'paper';
process.env.SECURITY_PROVIDER = 'mock';
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.TELEGRAM_AUTHORIZED_USER_IDS = '';

describeIf('E2E: pipeline + restart durability', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    // Apply migrations.
    const dir = path.join(process.cwd(), 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    // Clean slate — order matters (FKs).
    await pool.query('TRUNCATE executions, trade_proposals, signals, tokens RESTART IDENTITY CASCADE');
    await pool.query('UPDATE portfolio_state SET open_positions = 0');
    await pool.query('DELETE FROM daily_pnl');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('runs a full paper tick and persists every stage', async () => {
    // Fresh process imports so config picks up env we set above.
    jest.resetModules();
    const { buildProductionApp } = await import('../../src/app/productionBootstrap');
    const { SignalLoop } = await import('../../src/app/signalLoop');
    const { FixtureFeed } = await import('../../src/data/feed');
    const { MomentumStrategy, defaultMomentumConfig } = await import('../../src/strategy/momentum');
    const { closeRedis } = await import('../../src/infra/redis');
    const { closePool } = await import('../../src/infra/db');

    const tokenMint = `TEST_MINT_${randomUUID()}`;
    const snapshots = [{
      tokenMint,
      fetchedAt: Date.now(),
      priceUsd: 0.001,
      liquidityUsd: 250_000,
      volume24hUsd: 1_200_000,
      holderCount: 3_200,
      top10HolderPercent: 22,
      smartWalletNetFlowUsd: 8_500,
      priceChange5mPercent: 6.4,
      priceChange1hPercent: 14.1,
    }];

    const app = buildProductionApp();
    const loop = new SignalLoop(
      {
        feed: new FixtureFeed(snapshots),
        strategy: new MomentumStrategy(defaultMomentumConfig),
        strategyContext: { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 },
        orchestrator: app.orchestrator,
        executor: app.executor,
      },
      { intervalMs: 60_000 },
    );

    const tick = await loop.runOnce();
    expect(tick.signals).toBe(1);
    expect(tick.approved).toBe(1);
    expect(tick.executed).toBe(1);
    expect(tick.failed).toBe(0);

    // Verify DB state.
    const tokens = await pool.query('SELECT mint FROM tokens WHERE mint = $1', [tokenMint]);
    expect(tokens.rows).toHaveLength(1);

    const signals = await pool.query('SELECT id FROM signals WHERE token_mint = $1', [tokenMint]);
    expect(signals.rows).toHaveLength(1);

    const proposals = await pool.query('SELECT status FROM trade_proposals WHERE token_mint = $1', [tokenMint]);
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0].status).toBe('EXECUTED');

    const executions = await pool.query('SELECT status, tx_signature FROM executions');
    expect(executions.rows.length).toBeGreaterThanOrEqual(1);
    expect(executions.rows[0].status).toBe('CONFIRMED');
    expect(executions.rows[0].tx_signature).toMatch(/^paper_/);

    const state = await pool.query('SELECT open_positions FROM portfolio_state WHERE id = 1');
    expect(Number(state.rows[0].open_positions)).toBeGreaterThanOrEqual(1);

    await closeRedis();
    await closePool();
  });

  it('state survives a simulated process restart', async () => {
    // Kill the pool from the previous test to simulate a restart.
    jest.resetModules();
    const { getPool, closePool } = await import('../../src/infra/db');
    const freshPool = getPool();

    // Assert the data from the previous run is visible through a brand-new pool.
    const count = await freshPool.query('SELECT COUNT(*)::int AS c FROM executions');
    expect(count.rows[0].c).toBeGreaterThanOrEqual(1);

    const props = await freshPool.query("SELECT COUNT(*)::int AS c FROM trade_proposals WHERE status = 'EXECUTED'");
    expect(props.rows[0].c).toBeGreaterThanOrEqual(1);

    const pos = await freshPool.query('SELECT open_positions FROM portfolio_state WHERE id = 1');
    expect(Number(pos.rows[0].open_positions)).toBeGreaterThanOrEqual(1);

    await closePool();
  });
});
