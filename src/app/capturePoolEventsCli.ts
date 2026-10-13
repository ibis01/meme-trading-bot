/**
 * Live capture of pump.fun pool creation events and subsequent price paths.
 *
 * Design:
 *   - Subscribes to Solana logs for pump.fun program.
 *   - For each creation event, records it with its deployer's 24h cadence.
 *   - Tokens passing the cadence filter are added to a polling set.
 *   - A single batcher polls all active tokens every 3 seconds via
 *     DexScreener's multi-token endpoint (30 mints per request).
 *   - Observations recorded for 5 minutes per token.
 *
 * Latency is deliberately not optimised — this measures whether the signal
 * has value in principle, not whether we can beat insider wallets.
 */
import { getPool, closePool } from '../infra/db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { LogsSubscribePoolSource } from '../data/poolEvents/logsSubscribeSource';
import { PoolEvent } from '../data/poolEvents/types';

const OBSERVATION_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3000;
const BATCH_SIZE = 30;
const MAX_ACTIVE = 500;
const DAY_MS = 86_400_000;
const PRIOR_LIMIT = 1;  // prior<=1 rule (1.29x lift on Kaggle validation)

interface ActiveToken { mint: string; startMs: number; }

class CaptureSystem {
  private readonly pool = getPool();
  private readonly active = new Map<string, ActiveToken>();
  private stopping = false;

  async start(): Promise<void> {
    const source = new LogsSubscribePoolSource(
      process.env.HELIUS_WS_URL!,
      config.SOLANA_RPC_URL!,
      {
        commitment: 'confirmed',
        sampleRate: 1,          // capture every event
        rpcConcurrency: 2,
        rpcMinSpacingMs: 400,
      },
    );

    source.onEvent((ev) => {
      this.onPoolEvent(ev).catch((err) =>
        logger.error({ err, mint: ev.baseMint }, 'onPoolEvent threw'),
      );
    });

    await source.start();
    logger.info({ maxActive: MAX_ACTIVE, priorLimit: PRIOR_LIMIT }, 'capture started');

    process.on('SIGINT',  () => { void this.shutdown(source); });
    process.on('SIGTERM', () => { void this.shutdown(source); });

    void this.pollLoop();
  }

  private async onPoolEvent(event: PoolEvent): Promise<void> {
    const mint = event.baseMint;
    const creator = event.creatorWallet;
    const detectedMs = event.blockTimeMs;

    const cadence = await this.pool.query<{ prior: number }>(
      `SELECT COUNT(*)::int AS prior FROM pool_events
       WHERE creator = $1 AND detected_at_ms >= $2 AND detected_at_ms < $3`,
      [creator, detectedMs - DAY_MS, detectedMs],
    );
    const prior24h = cadence.rows[0]?.prior ?? 0;
    const passesSignal = prior24h <= PRIOR_LIMIT;

    await this.pool.query(
      `INSERT INTO pool_events
         (mint, creator, detected_at_ms, slot, signature, pool_address,
          prior_launches_24h, passes_signal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (mint) DO NOTHING`,
      [mint, creator, detectedMs, event.slot, event.signature,
       event.poolAddress, prior24h, passesSignal],
    );

    if (!passesSignal) return;

    if (this.active.size >= MAX_ACTIVE) {
      logger.warn({ mint, active: this.active.size }, 'active set full, dropping');
      return;
    }
    this.active.set(mint, { mint, startMs: detectedMs });
    logger.info({ mint, prior24h }, 'added to polling');
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      const t0 = Date.now();
      try { await this.pollOnce(); }
      catch (err) { logger.error({ err }, 'pollOnce failed'); }
      const wait = Math.max(0, POLL_INTERVAL_MS - (Date.now() - t0));
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async pollOnce(): Promise<void> {
    const now = Date.now();
    for (const [mint, tok] of this.active) {
      if (now - tok.startMs >= OBSERVATION_MS) this.active.delete(mint);
    }
    const mints = [...this.active.keys()];
    if (mints.length === 0) return;

    for (let i = 0; i < mints.length; i += BATCH_SIZE) {
      await this.fetchAndRecord(mints.slice(i, i + BATCH_SIZE), now);
      if (i + BATCH_SIZE < mints.length) await new Promise((r) => setTimeout(r, 200));
    }
  }

  private async fetchAndRecord(mints: string[], nowMs: number): Promise<void> {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (err) {
      logger.warn({ err }, 'dexscreener fetch failed');
      return;
    }
    if (!res.ok) {
      logger.warn({ status: res.status }, 'dexscreener non-2xx');
      return;
    }
    const json = (await res.json()) as { pairs?: Array<Record<string, unknown>> };
    const pairs = json.pairs ?? [];

    const mintsSet = new Set(mints);
    const best = new Map<string, Record<string, unknown>>();
    for (const p of pairs) {
      if (p.chainId !== 'solana') continue;
      const base = (p.baseToken as { address?: string } | undefined)?.address;
      if (!base || !mintsSet.has(base)) continue;
      const liq = Number((p.liquidity as { usd?: number } | undefined)?.usd ?? 0);
      const prev = Number(((best.get(base)?.liquidity as { usd?: number } | undefined)?.usd) ?? -1);
      if (liq > prev) best.set(base, p);
    }

    for (const mint of mints) {
      const p = best.get(mint);
      const tok = this.active.get(mint);
      if (!p || !tok) continue;

      const price = Number(p.priceUsd);
      const liq = Number((p.liquidity as { usd?: number } | undefined)?.usd ?? 0);
      const vol = Number((p.volume as { h24?: number } | undefined)?.h24 ?? 0);
      const elapsed = nowMs - tok.startMs;

      try {
        await this.pool.query(
          `INSERT INTO price_observations
             (mint, elapsed_ms, observed_at_ms, price_usd, liquidity_usd, volume_24h_usd, source)
           VALUES ($1,$2,$3,$4,$5,$6,'dexscreener')
           ON CONFLICT (mint, observed_at_ms) DO NOTHING`,
          [mint, elapsed, nowMs, price, liq, vol],
        );
      } catch (err) {
        logger.warn({ err, mint }, 'observation insert failed');
      }
    }
  }

  private async shutdown(source: LogsSubscribePoolSource): Promise<void> {
    logger.info('shutting down');
    this.stopping = true;
    try { await source.stop(); } catch { /* ignore */ }
    await closePool();
    process.exit(0);
  }
}

async function main(): Promise<void> {
  if (!config.DATABASE_URL)    { logger.fatal('DATABASE_URL required');    process.exit(1); }
  if (!process.env.HELIUS_WS_URL)   { logger.fatal('SOLANA_WS_URL required');   process.exit(1); }
  if (!config.SOLANA_RPC_URL)  { logger.fatal('SOLANA_RPC_URL required');  process.exit(1); }
  const sys = new CaptureSystem();
  await sys.start();
}

main().catch((err) => { logger.fatal({ err }, 'capture failed'); process.exit(1); });
