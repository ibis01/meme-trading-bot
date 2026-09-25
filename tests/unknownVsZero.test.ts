import { BirdeyeMarketProvider } from '../src/data/birdeye';
import { HeliusMarketProvider } from '../src/data/helius';

const mkFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({
    ok,
    status: ok ? 200 : 500,
    text: async () => '',
    json: async () => payload,
  }) as Response) as unknown as typeof fetch;

describe('Rule 30: unknown ≠ zero (P1-10)', () => {
  it('Birdeye does not fabricate top10HolderPercent', async () => {
    const p = new BirdeyeMarketProvider('k', 'http://x', mkFetch({
      data: {
        price: 0.001,
        liquidity: 250_000,
        v24hUSD: 1_200_000,
        holder: 3_500,
        priceChange5mPercent: 2.1,
        priceChange1hPercent: 5.4,
      },
    }));
    const snap = await p.fetchSnapshot('mint');
    expect(snap).not.toBeNull();
    // Explicit: undefined, not 0.
    expect(snap!.top10HolderPercent).toBeUndefined();
    expect(snap!.smartWalletNetFlowUsd).toBeUndefined();
    // Present fields stay present.
    expect(snap!.holderCount).toBe(3_500);
  });

  it('Helius fails closed when a required field is missing', async () => {
    // Helius's contract treats top10HolderPercent as required (documented).
    // A missing field must produce null, not a fabricated 0. That is the
    // Rule 30 behavior: unknown means 'no snapshot', not 'zero'.
    const p = new HeliusMarketProvider('k', 'http://x', mkFetch({
      result: {
        liquidityUsd: 100_000,
        priceUsd: 0.001,
        volume24hUsd: 500_000,
        holderCount: 1_000,
        // top10HolderPercent intentionally missing
        priceChange5mPercent: 3,
        priceChange1hPercent: 6,
      },
    }));
    const snap = await p.fetchSnapshot('mint');
    expect(snap).toBeNull();
  });
});
