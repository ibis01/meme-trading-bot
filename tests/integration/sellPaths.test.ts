/**
 * Audit C4 (2026-11-24): SELL data model + fill booking against REAL Postgres.
 *
 * Exercises the seven production SELL paths — manual /sell (full + partial),
 * /closeall, stop-loss, take-profit, time-stop, and kill-switch SELL — at
 * the database boundary where the pre-fix bug crashed: every SELL proposal
 * carried amount_sol = 0 into a CHECK (amount_sol > 0) column.
 *
 * Requires:
 *   docker compose -f docker/docker-compose.yml up -d postgres redis
 *   npm run db:create:test
 * Run with:
 *   npm run test:integration
 *
 * Without INTEGRATION=1 this file skips so `npm test` stays hermetic.
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const RUN = process.env.INTEGRATION === '1';
const describeIf = RUN ? describe : describe.skip;

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL
  ?? 'postgresql://user:pass@localhost:5432/meme_bot_test';

describeIf('SELL paths against real Postgres (audit C4/C1/C3)', () => {
  let pool: Pool;

  const MINT = 'MintMintMintMintMintMintMintMintMintMintAA';

  async function insertToken(mint: string): Promise<void> {
    await pool.query(
      'INSERT INTO tokens (mint) VALUES ($1) ON CONFLICT (mint) DO NOTHING',
      [mint],
    );
  }

  async function insertProposal(o: {
    id: string;
    tradeRequestId: string;
    side: 'BUY' | 'SELL';
    amountSol: number | null;
    sellPercentBps: number | null;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO trade_proposals
         (id, trade_request_id, token_mint, side, amount_sol, sell_percent_bps, risk_decision, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'APPROVED')`,
      [o.id, o.tradeRequestId, MINT, o.side, o.amountSol, o.sellPercentBps, JSON.stringify({})],
    );
  }

  async function insertExecution(o: {
    id: string;
    proposalId: string;
    tradeRequestId: string;
    txSignature: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO executions (id, proposal_id, trade_request_id, tx_signature, status)
       VALUES ($1, $2, $3, $4, 'CONFIRMED')`,
      [o.id, o.proposalId, o.tradeRequestId, o.txSignature],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const dir = path.join(process.cwd(), 'db', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      await pool.query(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    await pool.query(
      'TRUNCATE ledger_reconciliation_status, position_fills, positions, executions, trade_proposals, signals, tokens RESTART IDENTITY CASCADE',
    );
    await pool.query('DELETE FROM daily_pnl');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('migration 014: SELL proposals may carry NULL amount_sol with bps evidence', async () => {
    await insertToken(MINT);
    // All seven SELL paths converge on this row shape — the pre-fix schema
    // (CHECK amount_sol > 0) crashed here.
    await expect(
      insertProposal({ id: 'sp-sell-full', tradeRequestId: 'tr-sell-full', side: 'SELL', amountSol: null, sellPercentBps: 10_000 }),
    ).resolves.toBeUndefined();
    await expect(
      insertProposal({ id: 'sp-sell-partial', tradeRequestId: 'tr-sell-partial', side: 'SELL', amountSol: null, sellPercentBps: 5_000 }),
    ).resolves.toBeUndefined();
    await expect(
      insertProposal({ id: 'sp-sell-closeall', tradeRequestId: 'tr-sell-closeall', side: 'SELL', amountSol: null, sellPercentBps: 10_000 }),
    ).resolves.toBeUndefined();
    await expect(
      insertProposal({ id: 'sp-sell-stoploss', tradeRequestId: 'tr-sell-stoploss', side: 'SELL', amountSol: null, sellPercentBps: 10_000 }),
    ).resolves.toBeUndefined();
    await expect(
      insertProposal({ id: 'sp-sell-takeprofit', tradeRequestId: 'tr-sell-takeprofit', side: 'SELL', amountSol: null, sellPercentBps: 10_000 }),
    ).resolves.toBeUndefined();
    await expect(
      insertProposal({ id: 'sp-sell-timestop', tradeRequestId: 'tr-sell-timestop', side: 'SELL', amountSol: null, sellPercentBps: 10_000 }),
    ).resolves.toBeUndefined();
    await expect(
      insertProposal({ id: 'sp-sell-killswitch', tradeRequestId: 'tr-sell-killswitch', side: 'SELL', amountSol: null, sellPercentBps: 10_000 }),
    ).resolves.toBeUndefined();
  });

  it('migration 014: BUY proposals still require a positive amount_sol', async () => {
    await expect(
      insertProposal({ id: 'sp-buy-ok', tradeRequestId: 'tr-buy-ok', side: 'BUY', amountSol: 0.05, sellPercentBps: null }),
    ).resolves.toBeUndefined();
    await expect(
      insertProposal({ id: 'sp-buy-zero', tradeRequestId: 'tr-buy-zero', side: 'BUY', amountSol: 0, sellPercentBps: null }),
    ).rejects.toThrow();
    // SELL without bps evidence is a violation (stricter than the sketch).
    await expect(
      insertProposal({ id: 'sp-sell-nobps', tradeRequestId: 'tr-sell-nobps', side: 'SELL', amountSol: null, sellPercentBps: null }),
    ).rejects.toThrow();
  });

  it('fill booking: BUY then SELL books positions + PnL atomically, replay is a no-op', async () => {
    await insertToken(MINT);
    await insertProposal({ id: 'fb-buy', tradeRequestId: 'fb-tr-buy', side: 'BUY', amountSol: 0.5, sellPercentBps: null });
    await insertProposal({ id: 'fb-sell', tradeRequestId: 'fb-tr-sell', side: 'SELL', amountSol: null, sellPercentBps: 10_000 });
    await insertExecution({ id: 'fb-exec-buy', proposalId: 'fb-buy', tradeRequestId: 'fb-tr-buy', txSignature: 'fb-sig-buy' });
    await insertExecution({ id: 'fb-exec-sell', proposalId: 'fb-sell', tradeRequestId: 'fb-tr-sell', txSignature: 'fb-sig-sell' });

    const { PostgresFillLedger } = await import('../../src/execution/fillLedger');
    const ledger = new PostgresFillLedger(pool);

    const buy = await ledger.bookFill({
      executionId: 'fb-exec-buy', proposalId: 'fb-buy', tradeRequestId: 'fb-tr-buy',
      side: 'BUY', tokenMint: MINT, txSignature: 'fb-sig-buy',
      filledTokenAmount: 1000, filledAmountSol: 0.5, source: 'IMMEDIATE',
    });
    expect(buy.kind).toBe('BOOKED');

    const sell = await ledger.bookFill({
      executionId: 'fb-exec-sell', proposalId: 'fb-sell', tradeRequestId: 'fb-tr-sell',
      side: 'SELL', tokenMint: MINT, txSignature: 'fb-sig-sell',
      filledTokenAmount: 1000, filledAmountSol: 0.6, source: 'RECONCILED',
    });
    expect(sell.kind).toBe('BOOKED');
    if (sell.kind === 'BOOKED') {
      expect(sell.realizedPnlSol).toBeCloseTo(0.1, 6);
    }

    const pnlRow = await pool.query('SELECT realized_pnl_sol FROM daily_pnl');
    expect(Number(pnlRow.rows[0].realized_pnl_sol)).toBeCloseTo(0.1, 6);

    const posRow = await pool.query('SELECT quantity FROM positions WHERE token_mint = $1', [MINT]);
    expect(Number(posRow.rows[0].quantity)).toBeCloseTo(0, 6);

    // Replay both bookings — signature uniqueness + status row make this a no-op.
    const replayBuy = await ledger.bookFill({
      executionId: 'fb-exec-buy', proposalId: 'fb-buy', tradeRequestId: 'fb-tr-buy',
      side: 'BUY', tokenMint: MINT, txSignature: 'fb-sig-buy',
      filledTokenAmount: 1000, filledAmountSol: 0.5, source: 'IMMEDIATE',
    });
    const replaySell = await ledger.bookFill({
      executionId: 'fb-exec-sell', proposalId: 'fb-sell', tradeRequestId: 'fb-tr-sell',
      side: 'SELL', tokenMint: MINT, txSignature: 'fb-sig-sell',
      filledTokenAmount: 1000, filledAmountSol: 0.6, source: 'RECONCILED',
    });
    expect(replayBuy.kind).toBe('ALREADY_BOOKED');
    expect(replaySell.kind).toBe('ALREADY_BOOKED');
    const fills = await pool.query('SELECT COUNT(*)::int AS c FROM position_fills');
    expect(fills.rows[0].c).toBe(2);
    const pnlAfter = await pool.query('SELECT realized_pnl_sol FROM daily_pnl');
    expect(Number(pnlAfter.rows[0].realized_pnl_sol)).toBeCloseTo(0.1, 6);
  });

  it('fill booking: SELL exceeding recorded holdings is UNRECONCILABLE and blocks BUYs', async () => {
    await insertToken(MINT);
    await insertProposal({ id: 'uc-buy', tradeRequestId: 'uc-tr-buy', side: 'BUY', amountSol: 0.5, sellPercentBps: null });
    await insertProposal({ id: 'uc-sell', tradeRequestId: 'uc-tr-sell', side: 'SELL', amountSol: null, sellPercentBps: 10_000 });
    await insertExecution({ id: 'uc-exec-buy', proposalId: 'uc-buy', tradeRequestId: 'uc-tr-buy', txSignature: 'uc-sig-buy' });
    await insertExecution({ id: 'uc-exec-sell', proposalId: 'uc-sell', tradeRequestId: 'uc-tr-sell', txSignature: 'uc-sig-sell' });

    const { PostgresFillLedger } = await import('../../src/execution/fillLedger');
    const ledger = new PostgresFillLedger(pool);

    await ledger.bookFill({
      executionId: 'uc-exec-buy', proposalId: 'uc-buy', tradeRequestId: 'uc-tr-buy',
      side: 'BUY', tokenMint: MINT, txSignature: 'uc-sig-buy',
      filledTokenAmount: 500, filledAmountSol: 0.5, source: 'IMMEDIATE',
    });
    const r = await ledger.bookFill({
      executionId: 'uc-exec-sell', proposalId: 'uc-sell', tradeRequestId: 'uc-tr-sell',
      side: 'SELL', tokenMint: MINT, txSignature: 'uc-sig-sell',
      filledTokenAmount: 999, filledAmountSol: 0.9, source: 'RECONCILED',
    });
    expect(r.kind).toBe('UNRECONCILABLE');

    const status = await pool.query(
      "SELECT booking_status, last_error FROM ledger_reconciliation_status WHERE execution_id = 'uc-exec-sell'",
    );
    expect(status.rows[0].booking_status).toBe('UNRECONCILABLE');
    expect(status.rows[0].last_error).toContain('SELL_EXCEEDS_HOLDINGS');

    const health = await ledger.isLedgerHealthy();
    expect(health.healthy).toBe(false);
    expect(health.unresolved).toBeGreaterThanOrEqual(1);
  });

  it('repair sweep discovers a CONFIRMED execution with no booking (crash gap)', async () => {
    await insertToken(MINT);
    await insertProposal({ id: 'rp-buy', tradeRequestId: 'rp-tr-buy', side: 'BUY', amountSol: 0.05, sellPercentBps: null });
    await insertExecution({ id: 'rp-exec-buy', proposalId: 'rp-buy', tradeRequestId: 'rp-tr-buy', txSignature: 'rp-sig-buy' });

    const { PostgresFillLedger } = await import('../../src/execution/fillLedger');
    const ledger = new PostgresFillLedger(pool);

    const candidates = await ledger.listRepairCandidates(10);
    expect(candidates.some((c) => c.executionId === 'rp-exec-buy')).toBe(true);

    await ledger.bookFill({
      executionId: 'rp-exec-buy', proposalId: 'rp-buy', tradeRequestId: 'rp-tr-buy',
      side: 'BUY', tokenMint: MINT, txSignature: 'rp-sig-buy',
      filledTokenAmount: 100, filledAmountSol: 0.05, source: 'RECONCILED',
    });
    const after = await ledger.listRepairCandidates(10);
    expect(after.some((c) => c.executionId === 'rp-exec-buy')).toBe(false);
  });
});
