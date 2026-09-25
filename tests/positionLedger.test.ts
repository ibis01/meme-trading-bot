import { InMemoryPositionLedger } from '../src/state/positions/inMemoryLedger';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function ledger() {
  return new InMemoryPositionLedger();
}

describe('InMemoryPositionLedger (P0-4a, Rules 6/15/21)', () => {
  it('opening a new position records the correct avg cost', async () => {
    const l = ledger();
    const p = await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    expect(p.quantity).toBe(100);
    expect(p.avgCostSol).toBeCloseTo(0.01, 10);
    expect(p.closedAt).toBeUndefined();
  });

  it('averaging in produces a weighted average', async () => {
    const l = ledger();
    await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    await l.open({ tokenMint: MINT, tradeRequestId: 'tr2', quantity: 100, priceSol: 0.02, signature: 's2' });
    const p = await l.get(MINT);
    expect(p!.quantity).toBe(200);
    expect(p!.avgCostSol).toBeCloseTo(0.015, 10);
  });

  it('partial close computes realized PnL correctly', async () => {
    const l = ledger();
    await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    const r = await l.close({ tokenMint: MINT, tradeRequestId: 'tr2', quantity: 40, priceSol: 0.02, signature: 's2' });
    // cost basis of 40 units @ 0.01 = 0.4
    expect(r.costBasisSol).toBeCloseTo(0.4, 10);
    // proceeds 40 @ 0.02 = 0.8, PnL = 0.4
    expect(r.realizedPnlSol).toBeCloseTo(0.4, 10);
    expect(r.remainingQuantity).toBe(60);

    const p = await l.get(MINT);
    expect(p!.quantity).toBe(60);
    expect(p!.avgCostSol).toBeCloseTo(0.01, 10); // unchanged
  });

  it('full close zeroes quantity and sets closedAt', async () => {
    const l = ledger();
    await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    const r = await l.close({ tokenMint: MINT, tradeRequestId: 'tr2', quantity: 100, priceSol: 0.03, signature: 's2' });
    expect(r.remainingQuantity).toBe(0);
    const p = await l.get(MINT);
    expect(p!.quantity).toBe(0);
    expect(p!.closedAt).toBeDefined();
  });

  it('reopening after full close resets avg cost', async () => {
    const l = ledger();
    await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    await l.close({ tokenMint: MINT, tradeRequestId: 'tr2', quantity: 100, priceSol: 0.02, signature: 's2' });
    await l.open({ tokenMint: MINT, tradeRequestId: 'tr3', quantity: 50, priceSol: 0.05, signature: 's3' });
    const p = await l.get(MINT);
    expect(p!.quantity).toBe(50);
    expect(p!.avgCostSol).toBeCloseTo(0.05, 10);
  });

  it('rejects closing without an open position', async () => {
    const l = ledger();
    await expect(l.close({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 10, priceSol: 0.01, signature: 's1' }))
      .rejects.toThrow('NO_OPEN_POSITION');
  });

  it('rejects closing more than held', async () => {
    const l = ledger();
    await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    await expect(l.close({ tokenMint: MINT, tradeRequestId: 'tr2', quantity: 200, priceSol: 0.02, signature: 's2' }))
      .rejects.toThrow('INSUFFICIENT_QUANTITY');
  });

  it('rejects invalid quantity or price', async () => {
    const l = ledger();
    await expect(l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 0, priceSol: 0.01, signature: 's1' }))
      .rejects.toThrow('INVALID_QUANTITY');
    await expect(l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 1, priceSol: -1, signature: 's1' }))
      .rejects.toThrow('INVALID_PRICE');
  });

  it('Rule 25: rejects duplicate tradeRequestId', async () => {
    const l = ledger();
    await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    await expect(
      l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 50, priceSol: 0.02, signature: 's2' }),
    ).rejects.toThrow('DUPLICATE_TRADE_REQUEST');
  });

  it('getOpenCount reflects only open positions', async () => {
    const l = ledger();
    const MINT2 = 'So11111111111111111111111111111111111111112';
    await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    await l.open({ tokenMint: MINT2, tradeRequestId: 'tr2', quantity: 100, priceSol: 0.01, signature: 's2' });
    expect(await l.getOpenCount()).toBe(2);
    await l.close({ tokenMint: MINT, tradeRequestId: 'tr3', quantity: 100, priceSol: 0.02, signature: 's3' });
    expect(await l.getOpenCount()).toBe(1);
  });

  it('list returns only open positions', async () => {
    const l = ledger();
    await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    await l.close({ tokenMint: MINT, tradeRequestId: 'tr2', quantity: 100, priceSol: 0.02, signature: 's2' });
    expect(await l.list()).toEqual([]);
  });

  it('fills are recorded and retrievable', async () => {
    const l = ledger();
    const p = await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    await l.close({ tokenMint: MINT, tradeRequestId: 'tr2', quantity: 40, priceSol: 0.02, signature: 's2' });
    const fills = await l.getFills(p.id);
    expect(fills).toHaveLength(2);
    expect(fills[0].side).toBe('BUY');
    expect(fills[1].side).toBe('SELL');
    expect(fills[1].totalSol).toBeCloseTo(0.8, 10);
  });

  it('returns defensive copies (no external mutation of internal state)', async () => {
    const l = ledger();
    const p = await l.open({ tokenMint: MINT, tradeRequestId: 'tr1', quantity: 100, priceSol: 0.01, signature: 's1' });
    p.quantity = 9999;
    const fresh = await l.get(MINT);
    expect(fresh!.quantity).toBe(100);
  });
});
