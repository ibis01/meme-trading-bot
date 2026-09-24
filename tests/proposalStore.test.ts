import { InMemoryProposalStore } from '../src/state/proposals';
import { TradeProposal, RiskDecision } from '../src/risk/types';

const mkProposal = (): TradeProposal => ({
  tokenMint: 'mint',
  side: 'BUY',
  amountSol: 0.05,
  expectedSlippageBps: 100,
  expectedPriceImpactBps: 150,
  quoteFetchedAt: Date.now(),
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
});

const mkDecision = (allowed: boolean): RiskDecision =>
  allowed ? { allowed: true } : { allowed: false, reason: 'TEST' };

describe('ProposalStore', () => {
  it('persists and retrieves by tradeRequestId', async () => {
    const store = new InMemoryProposalStore();
    await store.save({
      id: 'p1', tradeRequestId: 'tr_1', signalId: 's1',
      proposal: mkProposal(), decision: mkDecision(true),
      status: 'APPROVED', createdAt: Date.now(),
    });
    const loaded = await store.getByRequestId('tr_1');
    expect(loaded!.id).toBe('p1');
    expect(loaded!.decision.allowed).toBe(true);
  });

  it('updateStatus mutates status only', async () => {
    const store = new InMemoryProposalStore();
    await store.save({
      id: 'p1', tradeRequestId: 'tr_1', signalId: 's1',
      proposal: mkProposal(), decision: mkDecision(true),
      status: 'APPROVED', createdAt: Date.now(),
    });
    await store.updateStatus('p1', 'EXECUTED');
    const loaded = await store.getByRequestId('tr_1');
    expect(loaded!.status).toBe('EXECUTED');
    expect(loaded!.decision.allowed).toBe(true);
  });
});
