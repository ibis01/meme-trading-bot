import { RugCheckProvider } from '../src/security/rugcheck';

const mkFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  }) as Response) as unknown as typeof fetch;

describe('RugCheckProvider (Rule 8 — fail closed)', () => {
  it('returns unsafe evidence on HTTP error', async () => {
    const p = new RugCheckProvider('http://x', mkFetch({}, false));
    const ev = await p.check('mint');
    expect(ev.mintAuthorityDisabled).toBe(false);
    expect(ev.freezeAuthorityDisabled).toBe(false);
    expect(ev.top10HolderPercent).toBe(100);
    expect(ev.liquidityUsd).toBe(0);
    expect(ev.sellabilityConfirmed).toBe(false);
  });

  it('returns unsafe evidence when numeric fields are missing', async () => {
    const p = new RugCheckProvider('http://x', mkFetch({ mintAuthority: null }));
    const ev = await p.check('mint');
    expect(ev.top10HolderPercent).toBe(100);
    expect(ev.liquidityUsd).toBe(0);
  });

  it('parses a well-formed response', async () => {
    const p = new RugCheckProvider('http://x', mkFetch({
      mintAuthority: null,
      freezeAuthority: null,
      top10HoldersPercent: 22,
      creatorHoldersPercent: 2,
      totalMarketLiquidity: 100_000,
      rugged: false,
    }));
    const ev = await p.check('mint');
    expect(ev.mintAuthorityDisabled).toBe(true);
    expect(ev.freezeAuthorityDisabled).toBe(true);
    expect(ev.top10HolderPercent).toBe(22);
    expect(ev.liquidityUsd).toBe(100_000);
    expect(ev.sellabilityConfirmed).toBe(true);
  });
});
