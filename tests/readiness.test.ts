import { Pool } from 'pg';
import { runReadinessChecks, ReadinessCheck } from '../src/app/readiness';

/** Fake pool: SELECT 1 succeeds; the schema probe is scriptable. */
function fakePool(schemaRow: Record<string, boolean>, failSelect1 = false): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('SELECT 1') && !sql.includes('information_schema')) {
        if (failSelect1) throw new Error('connection refused');
        return { rows: [] };
      }
      return { rows: [schemaRow] };
    },
  } as unknown as Pool;
}

const ALL_TRUE = {
  has_side_check: true,
  has_recon_table: true,
  has_sig_unique: true,
  has_unknown_status: true,
};

function names(results: ReadinessCheck[]): Array<[string, boolean]> {
  return results.map((r) => [r.name, r.ok] as [string, boolean]);
}

describe('runReadinessChecks (Gate 1d — fail-closed startup)', () => {
  const base = {
    tradingMode: 'paper' as const,
    requirePersistentState: false,
    securityProvider: 'rugcheck',
    marketSource: 'dexscreener',
    liveConfirmTimeoutMs: 60_000,
    liveConfirmPollMs: 2_000,
  };

  it('paper mode without REQUIRE_PERSISTENT_STATE is advisory and always ok', async () => {
    const out = await runReadinessChecks(base);
    expect(out.ok).toBe(true);
    expect(names(out.results)).toContainEqual(['readiness_enforced', true]);
  });

  it('REQUIRE_PERSISTENT_STATE=true makes the checks mandatory', async () => {
    const out = await runReadinessChecks({
      ...base,
      requirePersistentState: true,
      databaseUrl: 'postgresql://x',
      pool: fakePool(ALL_TRUE),
      redisPing: async () => undefined,
      killSwitchGet: async () => ({ active: false }),
    });
    expect(out.ok).toBe(true);
  });

  it('missing DATABASE_URL fails a mandatory run', async () => {
    const out = await runReadinessChecks({ ...base, requirePersistentState: true });
    expect(out.ok).toBe(false);
    expect(names(out.results)).toContainEqual(['database_url_present', false]);
  });

  it('unreachable Postgres fails', async () => {
    const out = await runReadinessChecks({
      ...base,
      requirePersistentState: true,
      databaseUrl: 'postgresql://x',
      pool: fakePool(ALL_TRUE, true),
    });
    expect(out.ok).toBe(false);
    expect(names(out.results)).toContainEqual(['postgres_reachable', false]);
  });

  it('stale schema (migrations not applied) fails with a migrate hint', async () => {
    const out = await runReadinessChecks({
      ...base,
      requirePersistentState: true,
      databaseUrl: 'postgresql://x',
      pool: fakePool({ ...ALL_TRUE, has_recon_table: false }),
    });
    expect(out.ok).toBe(false);
    const schema = out.results.find((r) => r.name === 'schema_current');
    expect(schema?.ok).toBe(false);
    expect(schema?.detail).toContain('db:migrate');
  });

  it('Redis outage and unreadable kill switch fail', async () => {
    const out = await runReadinessChecks({
      ...base,
      requirePersistentState: true,
      databaseUrl: 'postgresql://x',
      pool: fakePool(ALL_TRUE),
      redisPing: async () => {
        throw new Error('ECONNREFUSED');
      },
      killSwitchGet: async () => {
        throw new Error('kill switch store down');
      },
    });
    expect(out.ok).toBe(false);
    expect(names(out.results)).toContainEqual(['redis_reachable', false]);
    expect(names(out.results)).toContainEqual(['kill_switch_readable', false]);
  });

  it('mock security provider and fixture market data fail (Gate 0)', async () => {
    const out = await runReadinessChecks({
      ...base,
      requirePersistentState: true,
      databaseUrl: 'postgresql://x',
      pool: fakePool(ALL_TRUE),
      securityProvider: 'mock',
      marketSource: 'fixture',
    });
    expect(out.ok).toBe(false);
    expect(names(out.results)).toContainEqual(['security_provider_not_mock', false]);
    expect(names(out.results)).toContainEqual(['market_source_not_fixture', false]);
  });

  it('live mode requires a loaded wallet bound to EXPECTED_WALLET_PUBKEY', async () => {
    const missing = await runReadinessChecks({
      ...base,
      tradingMode: 'live',
      databaseUrl: 'postgresql://x',
      pool: fakePool(ALL_TRUE),
      walletPubkey: null,
    });
    expect(missing.ok).toBe(false);
    expect(names(missing.results)).toContainEqual(['wallet_key_loaded', false]);

    const unbound = await runReadinessChecks({
      ...base,
      tradingMode: 'live',
      databaseUrl: 'postgresql://x',
      pool: fakePool(ALL_TRUE),
      walletPubkey: 'Wallet111111111111111111111111111111111',
      expectedWalletPubkey: undefined,
    });
    expect(unbound.ok).toBe(false);
    expect(names(unbound.results)).toContainEqual(['wallet_pubkey_bound', false]);

    const mismatch = await runReadinessChecks({
      ...base,
      tradingMode: 'live',
      databaseUrl: 'postgresql://x',
      pool: fakePool(ALL_TRUE),
      walletPubkey: 'Wallet111111111111111111111111111111111',
      expectedWalletPubkey: 'Different1111111111111111111111111111111',
    });
    expect(mismatch.ok).toBe(false);
    expect(names(mismatch.results)).toContainEqual(['wallet_pubkey_bound', false]);

    const bound = await runReadinessChecks({
      ...base,
      tradingMode: 'live',
      databaseUrl: 'postgresql://x',
      pool: fakePool(ALL_TRUE),
      walletPubkey: 'Wallet111111111111111111111111111111111',
      expectedWalletPubkey: 'Wallet111111111111111111111111111111111',
    });
    expect(bound.ok).toBe(true);
  });
});
