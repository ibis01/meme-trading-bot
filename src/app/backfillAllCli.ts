import fs from 'fs';
import path from 'path';
import { BirdeyeHistoryProvider } from '../data/birdeyeHistory';
import { PostgresBarStore } from '../state/bars';
import { getPool, closePool } from '../infra/db';
import { config } from '../config';
import { logger } from '../utils/logger';

const INTERVAL_MS_BY_NAME: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

interface Args {
  mints: string[];
  intervalMs: number;
  intervalName: string;
  lookbackMs: number;
  delayBetweenMintsMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

  const intervalName = get('interval') ?? '1m';
  const intervalMs = INTERVAL_MS_BY_NAME[intervalName];
  if (!intervalMs) throw new Error(`Unsupported --interval: ${intervalName}`);

  const last = get('last') ?? '7d';
  const m = /^(\d+)([smhd])$/.exec(last);
  if (!m) throw new Error(`Invalid --last: ${last}. Use e.g. 30d, 24h`);
  const n = Number(m[1]);
  const mult = m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
  const lookbackMs = n * mult;

  const delayBetweenMintsMs = Number(get('delay') ?? 3000);

  const explicit = get('mints');
  if (explicit) {
    return {
      mints: explicit.split(',').map((s) => s.trim()).filter(Boolean),
      intervalMs, intervalName, lookbackMs, delayBetweenMintsMs,
    };
  }
  const file = path.resolve(process.cwd(), 'mints.txt');
  if (!fs.existsSync(file)) throw new Error('mints.txt not found and --mints not provided');
  const mints = fs.readFileSync(file, 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return { mints, intervalMs, intervalName, lookbackMs, delayBetweenMintsMs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!config.DATABASE_URL) { logger.fatal('DATABASE_URL required'); process.exit(1); }
  if (!config.BIRDEYE_API_KEY) { logger.fatal('BIRDEYE_API_KEY required'); process.exit(1); }

  const { mints, intervalMs, intervalName, lookbackMs, delayBetweenMintsMs } = parseArgs();
  const now = Date.now();
  const fromMs = now - lookbackMs;

  logger.info(
    {
      event: 'BACKFILL_ALL_START',
      mints: mints.length,
      interval: intervalName,
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(now).toISOString(),
      delayBetweenMintsMs,
    },
    'Batch backfill starting',
  );

  const provider = new BirdeyeHistoryProvider({ apiKey: config.BIRDEYE_API_KEY });
  const store = new PostgresBarStore(getPool());

  let okCount = 0;
  let emptyCount = 0;
  let failCount = 0;
  let totalBars = 0;

  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i];
    const label = `[${i + 1}/${mints.length}] ${mint.slice(0, 8)}…`;
    const startedAt = Date.now();
    try {
      const bars = await provider.fetchBars(mint, fromMs, now, intervalMs);
      if (bars.length === 0) {
        emptyCount += 1;
        logger.warn({ event: 'BACKFILL_ALL_EMPTY', mint }, `${label} — no bars returned`);
      } else {
        await store.saveMany(bars);
        totalBars += bars.length;
        okCount += 1;
        logger.info(
          { event: 'BACKFILL_ALL_MINT_OK', mint, bars: bars.length, durationMs: Date.now() - startedAt },
          `${label} — ${bars.length} bars in ${Date.now() - startedAt}ms`,
        );
      }
    } catch (err) {
      failCount += 1;
      logger.error({ event: 'BACKFILL_ALL_MINT_FAIL', mint, err }, `${label} — failed`);
    }

    if (i < mints.length - 1) await sleep(delayBetweenMintsMs);
  }

  logger.info(
    { event: 'BACKFILL_ALL_COMPLETE', okCount, emptyCount, failCount, totalBars },
    'Batch backfill complete',
  );

  console.log(JSON.stringify({
    mintsProcessed: mints.length,
    interval: intervalName,
    okCount,
    emptyCount,
    failCount,
    totalBars,
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(now).toISOString(),
  }, null, 2));

  await closePool();
}

main().catch((err) => { logger.fatal({ err }, 'backfillAll failed'); process.exit(1); });
