import { InMemoryFillLedger } from '../src/execution/fillLedger';
import { InMemoryPositionLedger } from '../src/state/positions/inMemoryLedger';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { InMemoryExecutionStore, StoredExecution } from '../src/state/executions';

const MINT = 'MintToken11111111111111111111111111111111';

function mkInput(over: Partial<Parameters<InMemoryFillLedger['bookFill']>[0]> = {}) {
  return {
    executionId: 'e1',
    proposalId: 'p1',
    tradeRequestId: 'sig:1',
    side: 'BUY' as const,
    tokenMint: MINT,
    txSignature: 'txsig1',
    filledTokenAmount: 100,
    filledAmountSol: 0.5,
    source: 'IMMEDIATE' as const,
    ...over,
  };
}

function mkExec(over: Partial<StoredExecution> = {}): StoredExecution {
  return {
    id: 'e1',
    proposalId: 'p1',
    tradeRequestId: 'sig:1',
    txSignature: 'txsig1',
    status: 'CONFIRMED',
    executedAt: Date.now(),
    ...over,
  };
}

describe('InMemoryFillLedger (audit C1/C2/C3 — canonical booking)', () => {
  it('BUY books a position once; replaying the same execution is ALREADY_BOOKED', async () => {
    const positions = new InMemoryPositionLedger();
    const ledger = new InMemoryFillLedger(positions, new InMemoryPnlStore());

    const first = await ledger.bookFill(mkInput());
    expect(first.kind).toBe('BOOKED');
    const pos = await positions.get(MINT);
    expect(pos?.quantity).toBe(100);
    expect(pos?.avgCostSol).toBeCloseTo(0.5 / 100, 12);

    // Reconciliation runner replays the same booking — idempotent.
    const replay = await ledger.bookFill(mkInput());
    expect(replay.kind).toBe('ALREADY_BOOKED');
    const posAfter = await positions.get(MINT);
    expect(posAfter?.quantity).toBe(100); // NOT 200
  });

  it('the same signature under a different execution cannot double-book', async () => {
    const positions = new InMemoryPositionLedger();
    const ledger = new InMemoryFillLedger(positions, new InMemoryPnlStore());
    await ledger.bookFill(mkInput());
    const replay = await ledger.bookFill(
      mkInput({ executionId: 'e2', tradeRequestId: 'sig:2' }),
    );
    expect(replay.kind).toBe('ALREADY_BOOKED');
    expect((await positions.get(MINT))?.quantity).toBe(100);
  });

  it('SELL books realized PnL exactly once', async () => {
    const positions = new InMemoryPositionLedger();
    const pnl = new InMemoryPnlStore();
    const ledger = new InMemoryFillLedger(positions, pnl);
    await ledger.bookFill(mkInput()); // BUY 100 @ 0.005 SOL/token

    const sell = await ledger.bookFill(
      mkInput({
        executionId: 'e2',
        tradeRequestId: 'sig:2',
        side: 'SELL',
        filledTokenAmount: 100,
        filledAmountSol: 0.6,
        txSignature: 'txsig2',
      }),
    );
    expect(sell.kind).toBe('BOOKED');
    if (sell.kind !== 'BOOKED') return;
    expect(sell.realizedPnlSol).toBeCloseTo(0.6 - 0.5, 12);
    expect(await pnl.getToday()).toBeCloseTo(0.1, 12);
    expect(await positions.get(MINT)).toBeNull(); // fully closed

    // Replayed reconciliation must not double-count PnL.
    const replay = await ledger.bookFill(
      mkInput({
        executionId: 'e2',
        tradeRequestId: 'sig:2',
        side: 'SELL',
        filledTokenAmount: 100,
        filledAmountSol: 0.6,
        txSignature: 'txsig2',
      }),
    );
    expect(replay.kind).toBe('ALREADY_BOOKED');
    expect(await pnl.getToday()).toBeCloseTo(0.1, 12);
  });

  it('SELL exceeding recorded holdings is UNRECONCILABLE — never silently clamped', async () => {
    const positions = new InMemoryPositionLedger();
    const pnl = new InMemoryPnlStore();
    const ledger = new InMemoryFillLedger(positions, pnl);
    await ledger.bookFill(mkInput()); // 100 held

    const r = await ledger.bookFill(
      mkInput({
        executionId: 'e2',
        tradeRequestId: 'sig:2',
        side: 'SELL',
        filledTokenAmount: 150,
        filledAmountSol: 0.9,
        txSignature: 'txsig2',
      }),
    );
    expect(r.kind).toBe('UNRECONCILABLE');
    if (r.kind !== 'UNRECONCILABLE') return;
    expect(r.reason).toBe('SELL_EXCEEDS_HOLDINGS');
    expect((await positions.get(MINT))?.quantity).toBe(100);
    expect(await pnl.getToday()).toBe(0);
    const health = await ledger.isLedgerHealthy();
    expect(health.healthy).toBe(false);
    expect(health.unresolved).toBe(1);
  });

  it('unusable fill amounts are rejected, never fabricated into positions', async () => {
    const positions = new InMemoryPositionLedger();
    const ledger = new InMemoryFillLedger(positions, new InMemoryPnlStore());
    const r = await ledger.bookFill(mkInput({ filledTokenAmount: 0 }));
    expect(r.kind).toBe('UNRECONCILABLE');
    expect(await positions.get(MINT)).toBeNull();
  });

  it('an unbookable fill blocks new BUYs via the health gate', async () => {
    const positions = new InMemoryPositionLedger();
    const ledger = new InMemoryFillLedger(positions, new InMemoryPnlStore());
    expect((await ledger.isLedgerHealthy()).healthy).toBe(true);
    await ledger.bookFill(mkInput({ filledTokenAmount: 0 }));
    const health = await ledger.isLedgerHealthy();
    expect(health.healthy).toBe(false);
    expect(health.unresolved).toBe(1);
  });

  it('repair sweep finds CONFIRMED executions whose booking never happened', async () => {
    const executions = new InMemoryExecutionStore();
    const positions = new InMemoryPositionLedger();
    const ledger = new InMemoryFillLedger(positions, new InMemoryPnlStore(), executions);
    await executions.save(mkExec()); // CONFIRMED, no booking attempt yet

    const candidates = await ledger.listRepairCandidates(10);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].executionId).toBe('e1');

    await ledger.bookFill(mkInput());
    expect(await ledger.listRepairCandidates(10)).toHaveLength(0);
    expect((await ledger.isLedgerHealthy()).healthy).toBe(true);
  });

  it('markUnbookable records contradictory evidence in the queue', async () => {
    const ledger = new InMemoryFillLedger(
      new InMemoryPositionLedger(),
      new InMemoryPnlStore(),
    );
    await ledger.markUnbookable('e9', 'txsig9', 'RECONCILED', 'REPAIR_ONCHAIN_CONTRADICTION');
    const health = await ledger.isLedgerHealthy();
    expect(health.healthy).toBe(false);
  });
});
