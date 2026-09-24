import { MockSecurityProvider } from '../src/security';

describe('Security Provider', () => {
  it('mock provider returns safe defaults', async () => {
    const provider = new MockSecurityProvider();
    const evidence = await provider.check('So11111111111111111111111111111111111111112');
    expect(evidence.mintAuthorityDisabled).toBe(true);
    expect(evidence.freezeAuthorityDisabled).toBe(true);
    expect(evidence.sellabilityConfirmed).toBe(true);
    expect(evidence.liquidityUsd).toBeGreaterThan(0);
    expect(evidence.source).toBe('mock');
  });

  it('mock provider applies overrides', async () => {
    const provider = new MockSecurityProvider({ liquidityUsd: 100 });
    const evidence = await provider.check('mint');
    expect(evidence.liquidityUsd).toBe(100);
  });
});
