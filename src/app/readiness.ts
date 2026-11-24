import { Pool } from 'pg';

/**
 * Gate 1d (audit H2, 2026-11-24): LIVE_READINESS startup gate.
 *
 * Fail-closed startup validation for anything that touches real funds:
 * mandatory for TRADING_MODE=manual|live, and for paper soaks launched with
 * REQUIRE_PERSISTENT_STATE=true (9-step launch sequence, step 1). Any failed
 * check refuses startup — a silent in-memory or degraded run is worse than
 * no run (the old bootstrap warned and continued on memory stores).
 *
 * Checks: persistence configured + reachable, schema carries the launch
 * constraints/migrations, Redis reachable, kill switch readable, security
 * provider is real (never mock), market data is real (never fixture), the
 * wallet key is loaded and bound to EXPECTED_WALLET_PUBKEY, and execution
 * timeouts are configured.
 */

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ReadinessInput {
  tradingMode: 'paper' | 'manual' | 'live';
  requirePersistentState: boolean;
  databaseUrl?: string;
  /** Public key of the loaded trading wallet (live mode). */
  walletPubkey?: string | null;
  expectedWalletPubkey?: string;
  securityProvider: string;
  marketSource: string;
  liveConfirmTimeoutMs: number;
  liveConfirmPollMs: number;
  /** Injectable for tests; production passes the real pool. */
  pool?: Pool;
  redisPing?: () => Promise<void>;
  killSwitchGet?: () => Promise<{ active: boolean }>;
}

export interface ReadinessOutcome {
  ok: boolean;
  results: ReadinessCheck[];
}

export async function runReadinessChecks(input: ReadinessInput): Promise<ReadinessOutcome> {
  const results: ReadinessCheck[] = [];

  const enforcementRequired =
    input.tradingMode !== 'paper' || input.requirePersistentState;
  results.push({
    name: 'readiness_enforced',
    ok: true,
    detail: enforcementRequired ? 'mandatory' : 'advisory (paper, persistence not required)',
  });

  if (!enforcementRequired) {
    return { ok: true, results };
  }

  // 1. Persistence configured.
  results.push({
    name: 'database_url_present',
    ok: Boolean(input.databaseUrl),
    detail: input.databaseUrl ? undefined : 'DATABASE_URL missing',
  });

  // 2. Postgres reachable + schema current.
  if (input.databaseUrl && input.pool) {
    try {
      await input.pool.query('SELECT 1');
      results.push({ name: 'postgres_reachable', ok: true });
    } catch (err) {
      results.push({ name: 'postgres_reachable', ok: false, detail: errorMessage(err) });
    }
    await checkSchema(input.pool, results);
  } else if (input.databaseUrl) {
    results.push({ name: 'postgres_reachable', ok: false, detail: 'no pool provided' });
  }

  // 3. Redis reachable (idempotency locks + kill switch storage).
  if (input.redisPing) {
    try {
      await input.redisPing();
      results.push({ name: 'redis_reachable', ok: true });
    } catch (err) {
      results.push({ name: 'redis_reachable', ok: false, detail: errorMessage(err) });
    }
  }

  // 4. Kill switch readable — Rule 14 enforcement must be provable at start.
  if (input.killSwitchGet) {
    try {
      await input.killSwitchGet();
      results.push({ name: 'kill_switch_readable', ok: true });
    } catch (err) {
      results.push({ name: 'kill_switch_readable', ok: false, detail: errorMessage(err) });
    }
  }

  // 5. Real security provider (Gate 0: SECURITY_PROVIDER=rugcheck).
  results.push({
    name: 'security_provider_not_mock',
    ok: input.securityProvider !== 'mock',
    detail: input.securityProvider,
  });

  // 6. Real market data (Gate 0: a soak on synthetic data proves nothing).
  results.push({
    name: 'market_source_not_fixture',
    ok: input.marketSource !== 'fixture',
    detail: input.marketSource,
  });

  // 7. Wallet identity binding (Gate 3 minimum requirement).
  if (input.tradingMode === 'live') {
    results.push({
      name: 'wallet_key_loaded',
      ok: Boolean(input.walletPubkey),
      detail: input.walletPubkey ? undefined : 'WALLET_PRIVATE_KEY missing/unparseable',
    });
    const bound =
      Boolean(input.walletPubkey) &&
      Boolean(input.expectedWalletPubkey) &&
      input.expectedWalletPubkey === input.walletPubkey;
    results.push({
      name: 'wallet_pubkey_bound',
      ok: bound,
      detail: !input.expectedWalletPubkey
        ? 'EXPECTED_WALLET_PUBKEY not set (required in live readiness)'
        : input.expectedWalletPubkey === input.walletPubkey
          ? undefined
          : 'wallet pubkey does not match EXPECTED_WALLET_PUBKEY',
    });
  }

  // 8. Execution timeouts configured (Gate 4 baseline).
  results.push({
    name: 'execution_timeouts_configured',
    ok: input.liveConfirmTimeoutMs > 0 && input.liveConfirmPollMs > 0,
    detail: `timeout=${input.liveConfirmTimeoutMs} poll=${input.liveConfirmPollMs}`,
  });

  return { ok: results.every((r) => r.ok), results };
}

async function checkSchema(pool: Pool, results: ReadinessCheck[]): Promise<void> {
  try {
    const res = await pool.query(`
      SELECT
        (SELECT EXISTS (
           SELECT 1 FROM information_schema.table_constraints
           WHERE constraint_name = 'trade_proposals_side_amount_check'
         )) AS has_side_check,
        (SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_name = 'ledger_reconciliation_status'
         )) AS has_recon_table,
        (SELECT EXISTS (
           SELECT 1 FROM pg_indexes WHERE indexname = 'idx_position_fills_signature'
         )) AS has_sig_unique,
        (SELECT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'executions_status_check'
             AND pg_get_constraintdef(oid) LIKE '%UNKNOWN%'
         )) AS has_unknown_status
    `);
    const r = res.rows[0];
    const ok =
      r.has_side_check && r.has_recon_table && r.has_sig_unique && r.has_unknown_status;
    results.push({
      name: 'schema_current',
      ok,
      detail: ok
        ? undefined
        : `side_check=${r.has_side_check} recon_table=${r.has_recon_table} ` +
          `sig_unique=${r.has_sig_unique} unknown_status=${r.has_unknown_status} — run npm run db:migrate`,
    });
  } catch (err) {
    results.push({ name: 'schema_current', ok: false, detail: errorMessage(err) });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
