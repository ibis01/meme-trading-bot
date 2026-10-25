import { TradeExecutor } from '../src/execution/executor';
import { ProposalStatus, StoredProposal } from '../src/state/proposals';

/**
 * Audit contract for the executor's Stage 0 shadow interception
 * (src/execution/executor.ts):
 *
 *   "this runs before the APPROVED check by design; nothing may set isShadow
 *    on a live-trading path until that ordering is explicitly reviewed and
 *    covered by tests."
 *
 * These are those tests. The ordering is now LOCKED: a shadow proposal is
 * simulated with zero side effects (no idempotency, no stores, no provider,
 * no kill switch, no risk engine), regardless of proposal status or side.
 * Phase 3 (execution intelligence) may only flip isShadow on real paths
 * after this contract is re-reviewed against these tests.
 */

/**
 * Every dependency the TradeExecutor could touch. Each mock THROWS if
 * invoked, so any side effect fails the test loudly instead of silently
 * succeeding — and the explicit not.toHaveBeenCalled() assertions below
 * document the contract in review-readable form.
 */
function mkExecutor() {
  const forbidding = (name: string) =>
    jest.fn(() => {
      throw new Error(`${name} must never be called for a shadow proposal`);
    });

  const deps = {
    riskEngine: { evaluate: forbidding('riskEngine.evaluate') },
    killSwitch: { get: forbidding('killSwitch.get') },
    positions: {
      get: forbidding('positions.get'),
      open: forbidding('positions.open'),
      close: forbidding('positions.close'),
      getOpenCount: forbidding('positions.getOpenCount'),
    },
    proposals: {
      save: forbidding('proposals.save'),
      updateStatus: forbidding('proposals.updateStatus'),
      getByRequestId: forbidding('proposals.getByRequestId'),
    },
    executions: {
      save: forbidding('executions.save'),
      getByRequestId: forbidding('executions.getByRequestId'),
      getBySignature: forbidding('executions.getBySignature'),
    },
    idempotency: {
      acquire: forbidding('idempotency.acquire'),
      release: forbidding('idempotency.release'),
    },
    provider: {
      name: 'mock',
      assertEnabled: forbidding('provider.assertEnabled'),
      execute: forbidding('provider.execute'),
    },
    pnl: { addSol: forbidding('pnl.addSol') },
  };

  const allMocks: Array<[string, jest.Mock]> = Object.entries(deps).flatMap(
    ([group, fns]) =>
      Object.entries(fns as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'function')
        .map(([fn, v]) => [`${group}.${fn}`, v as jest.Mock] as [string, jest.Mock]),
  );

  const executor = new TradeExecutor(
    deps as unknown as ConstructorParameters<typeof TradeExecutor>[0],
  );
  return { executor, allMocks };
}

const baseProposal = (over: {
  status?: ProposalStatus;
  side?: 'BUY' | 'SELL';
  keepShadow?: boolean;
}): StoredProposal => ({
  id: 'prop_shadow',
  tradeRequestId: 'sig:shadow_1',
  signalId: 'shadow_1',
  status: over.status ?? 'PENDING',
  createdAt: Date.now(),
  decision: { allowed: false, reason: 'NOT_REALLY_DECIDED' },
  proposal: {
    tokenMint: 'mint',
    side: over.side ?? 'BUY',
    amountSol: 0.05,
    expectedSlippageBps: 100,
    expectedPriceImpactBps: 150,
    quoteFetchedAt: Date.now(),
    isShadow: over.keepShadow ?? true,
    security: {
      tokenMint: 'mint',
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      top10HolderPercent: 20,
      devWalletPercent: 2,
      liquidityUsd: 100_000,
      sellabilityConfirmed: true,
      fetchedAt: Date.now(),
      source: 'mock',
    },
  },
});

describe('TradeExecutor Stage 0 — shadow interception', () => {
  it('simulates a shadow proposal as CONFIRMED with txSignature "shadow_sim"', async () => {
    const { executor } = mkExecutor();
    const r = await executor.execute(baseProposal({}));
    expect(r.kind).toBe('CONFIRMED');
    if (r.kind !== 'CONFIRMED') return;
    expect(r.execution.txSignature).toBe('shadow_sim');
    expect(r.execution.status).toBe('CONFIRMED');
    expect(r.execution.proposalId).toBe('prop_shadow');
    expect(r.execution.tradeRequestId).toBe('sig:shadow_1');
    expect(typeof r.execution.executedAt).toBe('number');
  });

  it('intercepts BEFORE the APPROVED check (documented ordering)', async () => {
    const { executor } = mkExecutor();
    // A shadow proposal must not depend on proposal status — the simulation
    // happens before Stage 1 validation by design.
    for (const status of ['PENDING', 'REJECTED', 'FAILED'] as ProposalStatus[]) {
      const r = await executor.execute(baseProposal({ status }));
      expect(r.kind).toBe('CONFIRMED');
      expect(r.kind === 'CONFIRMED' && r.execution.txSignature).toBe('shadow_sim');
    }
  });

  it('has ZERO side effects: no idempotency, stores, provider, risk, or kill switch', async () => {
    const { executor, allMocks } = mkExecutor();
    const r = await executor.execute(baseProposal({}));
    expect(r.kind).toBe('CONFIRMED');
    for (const [, mock] of allMocks) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it('intercepts SELL shadows without touching the position ledger', async () => {
    const { executor } = mkExecutor();
    const r = await executor.execute(baseProposal({ side: 'SELL' }));
    expect(r.kind).toBe('CONFIRMED');
    expect(r.kind === 'CONFIRMED' && r.execution.txSignature).toBe('shadow_sim');
  });

  it('does NOT shadow non-shadow proposals — normal validation still applies', async () => {
    const { executor } = mkExecutor();
    const plain = baseProposal({ status: 'PENDING', keepShadow: false });
    const r = await executor.execute(plain);
    expect(r.kind).toBe('REJECTED');
    expect(r.kind === 'REJECTED' && r.reason).toBe('PROPOSAL_NOT_APPROVED:PENDING');
  });
});
