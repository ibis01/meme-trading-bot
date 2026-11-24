import { RpcReconciler } from '../src/execution/rpcReconciler';
import { ReconciliationRunner } from '../src/execution/reconciliationRunner';
import { InMemoryExecutionStore, StoredExecution } from '../src/state/executions';
import { InMemoryProposalStore, StoredProposal } from '../src/state/proposals';
import { InMemoryFillLedger } from '../src/execution/fillLedger';
import { InMemoryPositionLedger } from '../src/state/positions/inMemoryLedger';
import { InMemoryPnlStore } from '../src/state/dailyPnl';
import { SolanaRpcClient } from '../src/data/solanaRpc';

const WALLET = 'WalletAddr1111111111111111111111111111111';
const MINT = 'MintToken11111111111111111111111111111111';

interface RpcCall {
  method: string;
  result: unknown;
}

/** Dispatching JSON-RPC mock: each method returns its scripted result. */
function mkRpc(calls: RpcCall[]): typeof fetch {
  return (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body) as { method: string };
    const call = calls.find((c) => c.method === body.method);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: call?.result ?? null }),
    } as Response;
  }) as unknown as typeof fetch;
}

/** A landed BUY tx: wallet spent 100_000 lamports net of fee/rent, got 1000 units @6dp. */
const LANDED_BUY_TX = {
  meta: {
    err: null,
    fee: 5_000,
    preBalances: [1_000_000, 0],
    postBalances: [845_000, 50_000],
    preTokenBalances: [
      { accountIndex: 0, mint: MINT, owner: WALLET, uiTokenAmount: { amount: '0' } },
    ],
    postTokenBalances: [
      { accountIndex: 0, mint: MINT, owner: WALLET, uiTokenAmount: { amount: '1000' } },
    ],
  },
  transaction: { message: { accountKeys: [WALLET, 'Pool111111111111111111111111111111111111'] } },
};

const mkExec = (o: Partial<StoredExecution> = {}): StoredExecution => ({
  id: 'e1',
  proposalId: 'p1',
  tradeRequestId: 'sig:1',
  txSignature: 'sig_xyz',
  status: 'SUBMITTED',
  executedAt: Date.now(),
  ...o,
});

const mkProp = (side: 'BUY' | 'SELL' = 'BUY'): StoredProposal => ({
  id: 'p1',
  tradeRequestId: 'sig:1',
  signalId: 's1',
  status: 'SUBMITTED',
  createdAt: Date.now(),
  decision: { allowed: true },
  proposal: {
    tokenMint: MINT, side, amountSol: 0.05,
    expectedSlippageBps: 100, expectedPriceImpactBps: 100,
    quoteFetchedAt: Date.now(),
    security: {
      tokenMint: MINT, mintAuthorityDisabled: true, freezeAuthorityDisabled: true,
      top10HolderPercent: 20, devWalletPercent: 2, liquidityUsd: 100_000,
      sellabilityConfirmed: true, fetchedAt: Date.now(), source: 'mock',
    },
  },
});

function mkReconciler(calls: RpcCall[]): RpcReconciler {
  return new RpcReconciler(new SolanaRpcClient('http://x', mkRpc(calls)), WALLET);
}

describe('RpcReconciler (audit C1 — real fill derivation, never zeros)', () => {
  it('returns STILL_UNKNOWN for missing signature', async () => {
    const r = mkReconciler([]);
    const out = await r.reconcile(mkExec({ txSignature: null }), mkProp());
    expect(out.status).toBe('STILL_UNKNOWN');
    expect(out.error).toBe('NO_SIGNATURE');
  });

  it('returns STILL_UNKNOWN without the proposal (no side/mint to derive)', async () => {
    const r = mkReconciler([]);
    const out = await r.reconcile(mkExec(), null);
    expect(out.status).toBe('STILL_UNKNOWN');
    expect(out.error).toBe('PROPOSAL_MISSING');
  });

  it('returns STILL_UNKNOWN when the RPC says null (never invents FAILED)', async () => {
    const r = mkReconciler([{ method: 'getTransaction', result: null }]);
    const out = await r.reconcile(mkExec(), mkProp());
    expect(out.status).toBe('STILL_UNKNOWN');
  });

  it('derives REAL fills for a landed BUY (fee/rent-exact, shared derivation)', async () => {
    const r = mkReconciler([
      { method: 'getTransaction', result: LANDED_BUY_TX },
      { method: 'getTokenSupply', result: { value: { decimals: 6 } } },
    ]);
    const out = await r.reconcile(mkExec(), mkProp('BUY'));
    expect(out.status).toBe('CONFIRMED');
    expect(out.filledAmountSol).toBeCloseTo(100_000 / 1e9, 12);
    expect(out.filledTokenAmount).toBeCloseTo(1000 / 10 ** 6, 12);
  });

  it('returns FAILED when the tx failed on-chain', async () => {
    const r = mkReconciler([
      {
        method: 'getTransaction',
        result: {
          meta: { err: { InstructionError: [0, 'Custom'] } },
          transaction: { message: { accountKeys: [WALLET] } },
        },
      },
    ]);
    const out = await r.reconcile(mkExec(), mkProp());
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('ONCHAIN_FAILED');
  });

  it('returns STILL_UNKNOWN (not CONFIRMED-with-zeros) when evidence is missing', async () => {
    // Wallet present but balance arrays absent → the derivation cannot prove
    // the fill. The old code returned CONFIRMED with filledAmountSol: 0 here
    // (audit C1); now it stays unresolved.
    const r = mkReconciler([
      {
        method: 'getTransaction',
        result: {
          meta: { err: null, fee: 5_000 },
          transaction: { message: { accountKeys: [WALLET] } },
        },
      },
      { method: 'getTokenSupply', result: { value: { decimals: 6 } } },
    ]);
    const out = await r.reconcile(mkExec(), mkProp());
    expect(out.status).toBe('STILL_UNKNOWN');
    expect(out.error).toBe('VERIFY_BALANCES_MISSING');
  });
});

describe('ReconciliationRunner (audit C1/C2 — books fills, repairs gaps)', () => {
  it('resolves a confirmed execution, updates the proposal, and BOOKS the fill', async () => {
    const executions = new InMemoryExecutionStore();
    const proposals = new InMemoryProposalStore();
    const positions = new InMemoryPositionLedger();
    const pnl = new InMemoryPnlStore();
    const ledger = new InMemoryFillLedger(positions, pnl, executions);
    await executions.save(mkExec());
    await proposals.save(mkProp('BUY'));

    const reconciler = mkReconciler([
      { method: 'getTransaction', result: LANDED_BUY_TX },
      { method: 'getTokenSupply', result: { value: { decimals: 6 } } },
    ]);

    const runner = new ReconciliationRunner(executions, proposals, reconciler, ledger);
    const r = await runner.runOnce();

    expect(r.scanned).toBe(1);
    expect(r.resolved).toBe(1);
    expect(r.booked).toBe(1);
    expect((await executions.getByRequestId('sig:1'))!.status).toBe('CONFIRMED');
    expect((await proposals.listRecent(1))[0].status).toBe('EXECUTED');
    // The fill reached the LEDGER (the pre-audit bug: status only, no booking).
    const pos = await positions.get(MINT);
    expect(pos?.quantity).toBeCloseTo(1000 / 10 ** 6, 12);
    expect((await ledger.isLedgerHealthy()).healthy).toBe(true);
  });

  it('re-running reconciliation does not double-book (idempotent)', async () => {
    const executions = new InMemoryExecutionStore();
    const proposals = new InMemoryProposalStore();
    const positions = new InMemoryPositionLedger();
    const pnl = new InMemoryPnlStore();
    const ledger = new InMemoryFillLedger(positions, pnl, executions);
    await executions.save(mkExec());
    await proposals.save(mkProp('BUY'));

    const reconciler = mkReconciler([
      { method: 'getTransaction', result: LANDED_BUY_TX },
      { method: 'getTokenSupply', result: { value: { decimals: 6 } } },
    ]);
    const runner = new ReconciliationRunner(executions, proposals, reconciler, ledger);

    await runner.runOnce();
    // First pass: execution resolved to CONFIRMED → no longer in listUnresolved.
    // Force a second pass over the same CONFIRMED execution via the repair sweep.
    const r2 = await runner.runOnce();
    expect(r2.resolved).toBe(0);
    expect((await positions.get(MINT))?.quantity).toBeCloseTo(1000 / 10 ** 6, 12); // unchanged
    expect(await pnl.getToday()).toBe(0);
  });

  it('repair sweep books a CONFIRMED execution whose fill never got booked', async () => {
    const executions = new InMemoryExecutionStore();
    const proposals = new InMemoryProposalStore();
    const positions = new InMemoryPositionLedger();
    const pnl = new InMemoryPnlStore();
    const ledger = new InMemoryFillLedger(positions, pnl, executions);
    // Crash-gap simulation: execution saved as CONFIRMED, booking never ran.
    await executions.save(mkExec({ status: 'CONFIRMED' }));
    await proposals.save(mkProp('BUY'));

    const reconciler = mkReconciler([
      { method: 'getTransaction', result: LANDED_BUY_TX },
      { method: 'getTokenSupply', result: { value: { decimals: 6 } } },
    ]);
    const runner = new ReconciliationRunner(executions, proposals, reconciler, ledger);

    const r = await runner.runOnce();
    expect(r.repaired).toBe(1);
    expect(r.booked).toBe(1);
    const pos = await positions.get(MINT);
    expect(pos?.quantity).toBeCloseTo(1000 / 10 ** 6, 12);
    expect((await ledger.isLedgerHealthy()).healthy).toBe(true);
  });

  it('repair sweep flags a CONFIRMED execution the chain says failed (contradiction)', async () => {
    const executions = new InMemoryExecutionStore();
    const proposals = new InMemoryProposalStore();
    const positions = new InMemoryPositionLedger();
    const ledger = new InMemoryFillLedger(positions, new InMemoryPnlStore(), executions);
    await executions.save(mkExec({ status: 'CONFIRMED' }));
    await proposals.save(mkProp('BUY'));

    const reconciler = mkReconciler([
      {
        method: 'getTransaction',
        result: {
          meta: { err: { InstructionError: [0, 'Custom'] } },
          transaction: { message: { accountKeys: [WALLET] } },
        },
      },
    ]);
    const runner = new ReconciliationRunner(executions, proposals, reconciler, ledger);

    const r = await runner.runOnce();
    expect(r.repaired).toBe(1);
    expect(r.unbookable).toBe(1);
    expect(await positions.get(MINT)).toBeNull();
    expect((await ledger.isLedgerHealthy()).healthy).toBe(false);
  });

  it('leaves still-unknown executions untouched', async () => {
    const executions = new InMemoryExecutionStore();
    const proposals = new InMemoryProposalStore();
    const positions = new InMemoryPositionLedger();
    const ledger = new InMemoryFillLedger(positions, new InMemoryPnlStore(), executions);
    await executions.save(mkExec());
    await proposals.save(mkProp());

    const reconciler = mkReconciler([{ method: 'getTransaction', result: null }]);
    const runner = new ReconciliationRunner(executions, proposals, reconciler, ledger);
    const r = await runner.runOnce();
    expect(r.stillUnknown).toBe(1);
    expect((await executions.getByRequestId('sig:1'))!.status).toBe('SUBMITTED');
    expect(await positions.get(MINT)).toBeNull();
  });

  it('skips already-resolved executions with nothing to repair', async () => {
    const executions = new InMemoryExecutionStore();
    const proposals = new InMemoryProposalStore();
    const positions = new InMemoryPositionLedger();
    const pnl = new InMemoryPnlStore();
    const ledger = new InMemoryFillLedger(positions, pnl, executions);
    await executions.save(mkExec({ status: 'CONFIRMED' }));
    await proposals.save(mkProp());
    // Booking already recorded for this execution:
    await ledger.bookFill({
      executionId: 'e1', proposalId: 'p1', tradeRequestId: 'sig:1',
      side: 'BUY', tokenMint: MINT, txSignature: 'sig_xyz',
      filledTokenAmount: 1, filledAmountSol: 0.5, source: 'IMMEDIATE',
    });

    const reconciler = mkReconciler([]);
    const runner = new ReconciliationRunner(executions, proposals, reconciler, ledger);
    const r = await runner.runOnce();
    expect(r.scanned).toBe(0);
    expect(r.repaired).toBe(0);
    expect(r.booked).toBe(0);
    expect(await pnl.getToday()).toBe(0);
  });
});
