import { PaperExecutionProvider, StaticPriceOracle } from '../src/execution/paper';

describe('PaperExecutionProvider (Rule 34 — safe default)', () => {
  it('always asserts enabled', () => {
    const p = new PaperExecutionProvider(new StaticPriceOracle({ mint: 0.01 }));
    expect(() => p.assertEnabled()).not.toThrow();
  });

  it('returns a CONFIRMED fill at oracle price', async () => {
    const p = new PaperExecutionProvider(new StaticPriceOracle({ mint: 0.01 }));
    const out = await p.execute({
      tradeRequestId: 'tr', tokenMint: 'mint', side: 'BUY',
      amountSol: 0.05, maxSlippageBps: 100, maxPriceImpactBps: 100,
      quoteFetchedAt: Date.now(),
    });
    expect(out.status).toBe('CONFIRMED');
    expect(out.filledPriceUsd).toBe(0.01);
    expect(out.filledAmountSol).toBe(0.05);
    expect(out.txSignature.startsWith('paper_')).toBe(true);
  });

  it('fails safely when oracle has no price', async () => {
    const p = new PaperExecutionProvider({ getPriceUsd: async () => 0 });
    const out = await p.execute({
      tradeRequestId: 'tr', tokenMint: 'mint', side: 'BUY',
      amountSol: 0.05, maxSlippageBps: 100, maxPriceImpactBps: 100,
      quoteFetchedAt: Date.now(),
    });
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('ORACLE_PRICE_UNAVAILABLE');
  });
});
