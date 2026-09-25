import { RpcReconciler } from '../src/execution/rpcReconciler';
import { ReconciliationRunner } from '../src/execution/reconciliationRunner';
import { InMemoryExecutionStore, StoredExecution } from '../src/state/executions';
import { InMemoryProposalStore, StoredProposal } from '../src/state/proposals';
import { SolanaRpcClient } from '../src/data/solanaRpc';

const mkFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({ ok, status: ok ? 200 : 500, json: async () => payload }) as Response) as unknown as typeof fetch;

const mkExec = (o: Partial<StoredExecution> = {}): StoredExecution => ({
  id: 'e1',
  proposalId: 'p1',
  tradeRequestId: 'sig:1',
  txSignature: 'sig_xyz',
  status: 'SUBMITTED',
  executedAt: Date.now(),
  ...o,
});

const mkProp = (): StoredProposal => ({
  id: 'p1',
  tradeRequestId: 'sig:1',
  signalId: 's1',
  status: 'SUBMITTED',
  createdAt: Date.now(),
  decision: { allowed: true },
  proposal: {
    tokenMint: 'mint', side: 'BUY', amountSol: 0.05,
    expectedSlippageBps: 100, expectedPriceImpactBps: 100,
    quoteFetchedAt: Date.now(),
    security: {
      tokenMint: 'mint', mintAuthorityDisabled: true, freezeAuthorityDisabled: true,
      top10HolderPercent: 20, devWalletPercent: 2, liquidityUsd: 100_000,
      sellabilityConfirmed: true, fetchedAt: Date.now(), source: 'mock',
    },
  },
});

describe('RpcReconciler (P1-7)', () => {
  it('returns STILL_UNKNOWN for missing signature', async () => {
    const r = new RpcReconciler(new SolanaRpcClient('http://x', mkFetch({})));
    const out = await r.reconcile(mkExec({ txSignature: null }));
    expect(out.status).toBe('STILL_UNKNOWN');
  });

  it('returns STILL_UNKNOWN when RPC says null', async () => {
    const r = new RpcReconciler(new SolanaRpcClient('http://x', mkFetch({ jsonrpc: '2.0', id: 1, result: null })));
    const out = await r.reconcile(mkExec());
    expect(out.status).toBe('STILL_UNKNOWN');
  });

  it('returns CONFIRMED when meta.err is absent', async () => {
    const r = new RpcReconciler(new SolanaRpcClient('http://x', mkFetch({
      jsonrpc: '2.0', id: 1, result: { meta: { err: null } },
    })));
    const out = await r.reconcile(mkExec());
    expect(out.status).toBe('CONFIRMED');
  });

  it('returns FAILED when meta.err is set', async () => {
    const r = new RpcReconciler(new SolanaRpcClient('http://x', mkFetch({
      jsonrpc: '2.0', id: 1, result: { meta: { err: { InstructionError: [0, 'X'] } } },
    })));
    const out = await r.reconcile(mkExec());
    expect(out.status).toBe('FAILED');
  });
});

describe('ReconciliationRunner (P1-7)', () => {
  it('resolves a confirmed execution and updates the proposal', async () => {
    const executions = new InMemoryExecutionStore();
    const proposals = new InMemoryProposalStore();
    await executions.save(mkExec());
    await proposals.save(mkProp());

    const reconciler = new RpcReconciler(new SolanaRpcClient('http://x', mkFetch({
      jsonrpc: '2.0', id: 1, result: { meta: { err: null } },
    })));

    const runner = new ReconciliationRunner(executions, proposals, reconciler);
    const r = await runner.runOnce();

    expect(r.scanned).toBe(1);
    expect(r.resolved).toBe(1);
    expect((await executions.getByRequestId('sig:1'))!.status).toBe('CONFIRMED');
    expect((await proposals.listRecent(1))[0].status).toBe('EXECUTED');
  });

  it('leaves still-unknown executions untouched', async () => {
    const executions = new InMemoryExecutionStore();
    const proposals = new InMemoryProposalStore();
    await executions.save(mkExec());
    await proposals.save(mkProp());

    const reconciler = new RpcReconciler(new SolanaRpcClient('http://x', mkFetch({
      jsonrpc: '2.0', id: 1, result: null,
    })));

    const runner = new ReconciliationRunner(executions, proposals, reconciler);
    const r = await runner.runOnce();
    expect(r.stillUnknown).toBe(1);
    expect((await executions.getByRequestId('sig:1'))!.status).toBe('SUBMITTED');
  });

  it('skips already-resolved executions', async () => {
    const executions = new InMemoryExecutionStore();
    const proposals = new InMemoryProposalStore();
    await executions.save(mkExec({ status: 'CONFIRMED' }));
    await proposals.save(mkProp());

    const reconciler = new RpcReconciler(new SolanaRpcClient('http://x', mkFetch({})));
    const runner = new ReconciliationRunner(executions, proposals, reconciler);
    const r = await runner.runOnce();
    expect(r.scanned).toBe(0);
  });
});
