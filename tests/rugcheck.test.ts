import { RugCheckProvider } from '../src/security/rugcheck';

const mkFetch = (payload: unknown, ok = true): typeof fetch =>
  (async () =>
    ({
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
    const p = new RugCheckProvider(
      'http://x',
      mkFetch({ mintAuthority: null }),
    );
    const ev = await p.check('mint');
    expect(ev.top10HolderPercent).toBe(100);
    expect(ev.liquidityUsd).toBe(0);
  });

  it('parses a well-formed response', async () => {
    const p = new RugCheckProvider(
      'http://x',
      mkFetch({
        mintAuthority: null,
        freezeAuthority: null,
        top10HoldersPercent: 22,
        creatorHoldersPercent: 2,
        totalMarketLiquidity: 100_000,
        rugged: false,
      }),
    );
    const ev = await p.check('mint');
    expect(ev.mintAuthorityDisabled).toBe(true);
    expect(ev.freezeAuthorityDisabled).toBe(true);
    expect(ev.top10HolderPercent).toBe(22);
    expect(ev.liquidityUsd).toBe(100_000);
    expect(ev.sellabilityConfirmed).toBe(true);
  });
});

describe('RugCheckProvider — authority fields fail CLOSED (audit fix H2)', () => {
  it('returns unsafe evidence when mint/freeze authority fields are ABSENT', async () => {
    // Numerics present, authority booleans missing entirely (API shape change).
    const p = new RugCheckProvider(
      'http://x',
      mkFetch({
        top10HoldersPercent: 22,
        creatorHoldersPercent: 2,
        totalMarketLiquidity: 100_000,
        rugged: false,
      }),
    );
    const ev = await p.check('mint');
    expect(ev.mintAuthorityDisabled).toBe(false); // fail CLOSED, not open
    expect(ev.freezeAuthorityDisabled).toBe(false);
    expect(ev.sellabilityConfirmed).toBe(false);
  });

  it('returns unsafe evidence when `rugged` is ABSENT', async () => {
    const p = new RugCheckProvider(
      'http://x',
      mkFetch({
        mintAuthority: null,
        freezeAuthority: null,
        top10HoldersPercent: 22,
        creatorHoldersPercent: 2,
        totalMarketLiquidity: 100_000,
      }),
    );
    const ev = await p.check('mint');
    expect(ev.sellabilityConfirmed).toBe(false);
    expect(ev.mintAuthorityDisabled).toBe(false); // whole evidence is unsafe
  });

  it('treats a non-null authority pubkey as authority ACTIVE', async () => {
    const p = new RugCheckProvider(
      'http://x',
      mkFetch({
        mintAuthority: 'SomeAuthorityPubkey1111111111111111111111111',
        freezeAuthority: null,
        top10HoldersPercent: 22,
        creatorHoldersPercent: 2,
        totalMarketLiquidity: 100_000,
        rugged: false,
      }),
    );
    const ev = await p.check('mint');
    expect(ev.mintAuthorityDisabled).toBe(false);
    expect(ev.freezeAuthorityDisabled).toBe(true);
  });

  it('accepts snake_case aliases with null authorities', async () => {
    const p = new RugCheckProvider(
      'http://x',
      mkFetch({
        mint_authority: null,
        freeze_authority: null,
        top10_holder_percent: '22',
        dev_wallet_percent: '2',
        liquidity_usd: '100000',
        rugged: false,
      }),
    );
    const ev = await p.check('mint');
    expect(ev.mintAuthorityDisabled).toBe(true);
    expect(ev.freezeAuthorityDisabled).toBe(true);
    expect(ev.top10HolderPercent).toBe(22);
  });
});
