import { vetMint, VetPair } from '../src/app/vetMints';

const NOW = 1_000_000_000_000;
const H = 3_600_000;
const pair = (over: Partial<VetPair> = {}): VetPair => ({
  chainId: 'solana',
  baseToken: { address: 'M', symbol: 'MEME' },
  liquidity: { usd: 500_000 },
  volume: { h24: 1_000_000 },
  pairCreatedAt: NOW - 48 * H,
  ...over,
});

describe('vetMint (Rule 30)', () => {
  it('passes a liquid, active, established token', () => {
    expect(vetMint('M', [pair()], NOW).status).toBe('PASS');
  });

  it('NO_PAIR when the mint is only ever the quote side or wrong chain', () => {
    expect(vetMint('M', [], NOW).status).toBe('NO_PAIR');
    expect(vetMint('M', [pair({ baseToken: { address: 'OTHER' } })], NOW).status).toBe('NO_PAIR');
    expect(vetMint('M', [pair({ chainId: 'ethereum' })], NOW).status).toBe('NO_PAIR');
  });

  it('missing fields are INCOMPLETE, never treated as zero', () => {
    expect(vetMint('M', [pair({ liquidity: undefined })], NOW).status).toBe('INCOMPLETE');
    expect(vetMint('M', [pair({ volume: undefined })], NOW).status).toBe('INCOMPLETE');
    expect(vetMint('M', [pair({ pairCreatedAt: undefined })], NOW).status).toBe('INCOMPLETE');
  });

  it('applies liquidity, volume and age thresholds', () => {
    expect(vetMint('M', [pair({ liquidity: { usd: 50_000 } })], NOW).status).toBe('LOW_LIQUIDITY');
    expect(vetMint('M', [pair({ volume: { h24: 10_000 } })], NOW).status).toBe('LOW_VOLUME');
    expect(vetMint('M', [pair({ pairCreatedAt: NOW - 2 * H })], NOW).status).toBe('TOO_NEW');
  });

  it('uses the most liquid base-side pair', () => {
    const r = vetMint('M', [pair({ liquidity: { usd: 1_000 } }), pair({ liquidity: { usd: 900_000 } })], NOW);
    expect(r.status).toBe('PASS');
    expect(r.liquidityUsd).toBe(900_000);
  });
});
